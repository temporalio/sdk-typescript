use crate::conversions::*;
use crate::errors::JavaScriptContextCustomErrors;
use neon::types::JsBigInt;
use neon::{context::Context, prelude::*};
use std::future::Future;
use std::net::SocketAddr;
use std::{
    cell::RefCell,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use temporal_sdk_core::api::telemetry::{
    HistogramBucketOverrides, OtelCollectorOptions, OtlpProtocol, PrometheusExporterOptions,
};
use temporal_sdk_core::{
    api::telemetry::OtelCollectorOptionsBuilder,
    api::telemetry::{Logger, MetricTemporality, TelemetryOptions, TelemetryOptionsBuilder},
    Url,
};
use temporal_sdk_core::{
    api::telemetry::{CoreTelemetry, PrometheusExporterOptionsBuilder},
    telemetry::{build_otlp_metric_exporter, start_prometheus_metric_exporter},
    CoreRuntime, TokioRuntimeBuilder,
};

////////////////////////////////////////////////////////////////////////////////////////////////////

/// This is the type that we actually pass to the lang side.
///
/// - JsBox: So that we're informed if the object is dropped by the lang GC
/// - RefCell: For interior mutability
/// - Option: So that we can take it out of the box on shutdown (requires mutability ^^^)
/// - Arc: So that we can safely pass the RuntimeHandle around
/// - RuntimeHandle: The actual runtime handle (below)
pub type BoxedRuntimeRef = JsBox<RefCell<Option<Arc<RuntimeHandle>>>>;

#[derive(Clone)]
pub struct RuntimeHandle {
    pub(crate) core_runtime: Arc<CoreRuntime>,
    pub(crate) cx_channel: Arc<Channel>,
}

impl Drop for RuntimeHandle {
    fn drop(&mut self) {
        println!("@@@@@ Dropping RuntimeHandle");
    }
}

impl Finalize for RuntimeHandle {}

////////////////////////////////////////////////////////////////////////////////////////////////////

// Below are functions exported to JS

/// Initialize Core global telemetry and create the tokio runtime required to run Core.
/// This should typically be called once on process startup.
pub fn runtime_new(mut cx: FunctionContext) -> JsResult<BoxedRuntimeRef> {
    let runtime_options = cx.argument::<JsObject>(0)?.as_runtime_options(&mut cx)?;

    let mut core_runtime = CoreRuntime::new(
        runtime_options.telemetry_options,
        TokioRuntimeBuilder::default(),
    )
    .or_else(|err| cx.throw_error(format!("Failed to initialize Core Runtime: {:?}", err)))?;

    match runtime_options.metrics_options {
        Some(MetricsConfig::Prometheus(prom_opts)) => {
            let _guard = core_runtime.tokio_handle().enter();

            let exporter = start_prometheus_metric_exporter(prom_opts).or_else(|err| {
                cx.throw_error(format!(
                    "Failed to start prometheus metrics exporter: {:?}",
                    err
                ))
            })?;

            core_runtime
                .telemetry_mut()
                .attach_late_init_metrics(exporter.meter);
        }
        Some(MetricsConfig::Otel(otel_opts)) => {
            let _guard = core_runtime.tokio_handle().enter();

            let exporter = build_otlp_metric_exporter(otel_opts).or_else(|err| {
                cx.throw_error(format!("Failed to start OTel metrics exporter: {:?}", err))
            })?;

            core_runtime
                .telemetry_mut()
                .attach_late_init_metrics(Arc::new(exporter));
        }
        None => {}
    }

    // FIXME: Implement log forwarding as push (we currently do it as pull)

    let runtime_handle = RuntimeHandle {
        core_runtime: Arc::new(core_runtime),
        cx_channel: Arc::new(cx.channel()),
    };

    Ok(cx.boxed(RefCell::new(Some(Arc::new(runtime_handle)))))
}

/// Stops the bridge runtime. In practice, this simply drops the RuntimeHandle out of the
/// BoxedRuntimeRef, and is therefore almost the same as just waiting for the lang-side GC
/// to drop the JS counterpart of BoxedRuntimeRef, but this one gives us a bit more control
/// on when that happens, which is useful for testing.
pub fn runtime_shutdown(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let runtime = cx.argument::<BoxedRuntimeRef>(0)?;
    runtime.shutdown(cx)
}

impl RuntimeHandle {
    #[allow(unused)]
    pub fn shutdown(self) -> Result<(), ()> {
        Ok(())
    }
}

trait BoxedRuntimeRefExt {
    fn shutdown(self, cx: FunctionContext) -> JsResult<JsUndefined>;
}

impl BoxedRuntimeRefExt for Handle<'_, BoxedRuntimeRef> {
    fn shutdown(self, mut cx: FunctionContext) -> JsResult<JsUndefined> {
        match self.take() {
            Some(_runtime) => {
                let res = Ok(cx.undefined());
                res
                // Arc::try_unwrap(runtime)
                // .map(|runtime| runtime.shutdown()?)
                // .and(Ok(cx.undefined()))
                // .map_err(|_| {
                //     cx.throw_illegal_state_error(format!(
                //             "Cannot finalize Runtime, expected 1 reference, got {}",
                //             Arc::strong_count(&runtime)
                //     )?
                // })?
            }
            None => cx.throw_illegal_state_error("Runtime has already been shutdown"),
        }
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

#[macro_export]
macro_rules! enter_sync {
    ($runtime:expr) => {
        if let Some(subscriber) = $runtime.core_runtime.telemetry().trace_subscriber() {
            temporal_sdk_core::telemetry::set_trace_subscriber_for_current_thread(subscriber);
        }
        let _guard = $runtime.core_runtime.tokio_handle().enter();
    };
}

pub trait FutureToPromise {
    fn future_to_promise<'a, C, F, R, T, E, S>(
        &self,
        cx: &mut C,
        future: F,
        settle_fn: S,
    ) -> JsResult<'a, JsPromise>
    where
        C: Context<'a>,
        F: Future<Output = anyhow::Result<R, E>> + Send + 'static,
        R: Send + 'static,
        E: Send + 'static,
        S: for<'b> FnOnce(&mut TaskContext<'b>, anyhow::Result<R, E>) -> JsResult<'b, T>
            + Send
            + 'static,
        T: Value;
}

// Implementation for plain RuntimeHandle
impl FutureToPromise for RuntimeHandle {
    fn future_to_promise<'a, C, F, R, T, E, S>(
        &self,
        cx: &mut C,
        future: F,
        settle_fn: S,
    ) -> JsResult<'a, JsPromise>
    where
        C: Context<'a>,
        F: Future<Output = anyhow::Result<R, E>> + Send + 'static,
        R: Send + 'static,
        E: Send + 'static,
        S: for<'b> FnOnce(&mut TaskContext<'b>, anyhow::Result<R, E>) -> JsResult<'b, T>
            + Send
            + 'static,
        T: Value,
    {
        let (deferred, promise) = cx.promise();
        let cx_channel = self.cx_channel.clone();

        let tokio_handle = self.core_runtime.tokio_handle();

        let _guard = tokio_handle.clone().enter();

        self.core_runtime.tokio_handle().spawn(async move {
            let result = future.await;

            if let Err(err) =
                deferred.try_settle_with(&cx_channel, move |mut cx| settle_fn(&mut cx, result))
            {
                eprint!("Failed to complete JS Promise: {:?}", err);
            }
        });

        Ok(promise)
    }
}

// Implementation for Arc<RuntimeHandle>
impl FutureToPromise for Arc<RuntimeHandle> {
    fn future_to_promise<'a, C, F, R, T, E, S>(
        &self,
        cx: &mut C,
        future: F,
        settle_fn: S,
    ) -> JsResult<'a, JsPromise>
    where
        C: Context<'a>,
        F: Future<Output = anyhow::Result<R, E>> + Send + 'static,
        R: Send + 'static,
        E: Send + 'static,
        S: for<'b> FnOnce(&mut TaskContext<'b>, anyhow::Result<R, E>) -> JsResult<'b, T>
            + Send
            + 'static,
        T: Value,
    {
        let handle_ref: &RuntimeHandle = self.as_ref();
        handle_ref.future_to_promise(cx, future, settle_fn)
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

struct RuntimeOptions {
    telemetry_options: TelemetryOptions,
    metrics_options: Option<MetricsConfig>,
}

pub enum MetricsConfig {
    Prometheus(PrometheusExporterOptions),
    Otel(OtelCollectorOptions),
}

trait RuntimeOptionsConversions {
    fn as_runtime_options(&self, cx: &mut FunctionContext) -> NeonResult<RuntimeOptions>;
}

impl RuntimeOptionsConversions for Handle<'_, JsObject> {
    fn as_runtime_options(&self, cx: &mut FunctionContext) -> NeonResult<RuntimeOptions> {
        let mut telemetry_opts = TelemetryOptionsBuilder::default();
        let mut metrics_opts: Option<MetricsConfig> = None;

        if let Some(ref logging) = js_optional_getter!(cx, self, "logging", JsObject) {
            let filter = js_value_getter!(cx, logging, "filter", JsString);
            if get_optional(cx, logging, "console").is_some() {
                telemetry_opts.logging(Logger::Console { filter });
            } else if get_optional(cx, logging, "forward").is_some() {
                telemetry_opts.logging(Logger::Forward { filter });
            } else {
                cx.throw_type_error(
                    "Invalid telemetryOptions.logging, expected either 'console' or 'forward' property",
                )?;
            }
        }

        if let Some(ref metrics) = js_optional_getter!(cx, self, "metrics", JsObject) {
            telemetry_opts.metric_prefix(js_value_getter!(cx, metrics, "metricPrefix", JsString));

            let global_tags = match js_optional_getter!(cx, metrics, "globalTags", JsObject) {
                None => None,
                Some(global_tags) => Some(global_tags.as_hash_map_of_string_to_string(cx)?),
            };

            telemetry_opts.attach_service_name(js_value_getter!(
                cx,
                metrics,
                "attachServiceName",
                JsBoolean
            ));

            if let Some(ref prom) = js_optional_getter!(cx, metrics, "prometheus", JsObject) {
                if js_optional_getter!(cx, metrics, "otel", JsObject).is_some() {
                    cx.throw_type_error(
                        "Invalid telemetryOptions.metrics: can't have both premetheus and otel at the same time",
                    )?
                }

                let mut options = PrometheusExporterOptionsBuilder::default();

                let addr = js_value_getter!(cx, prom, "bindAddress", JsString);
                match addr.parse::<SocketAddr>() {
                    Ok(addr) => options.socket_addr(addr),
                    Err(_) => {
                        return cx.throw_type_error(
                            "Invalid telemetryOptions.metrics.prometheus.bindAddress",
                        )?;
                    }
                };

                options.counters_total_suffix(js_value_getter!(
                    cx,
                    prom,
                    "countersTotalSuffix",
                    JsBoolean
                ));

                options.unit_suffix(js_value_getter!(cx, prom, "unitSuffix", JsBoolean));

                options.use_seconds_for_durations(js_value_getter!(
                    cx,
                    prom,
                    "useSecondsForDurations",
                    JsBoolean
                ));

                if let Some(global_tags) = global_tags {
                    options.global_tags(global_tags);
                }

                if let Some(histogram_bucket_overrides) =
                    js_optional_getter!(cx, prom, "histogramBucketOverrides", JsObject)
                {
                    options.histogram_bucket_overrides(HistogramBucketOverrides {
                        overrides: histogram_bucket_overrides
                            .as_hash_map_of_string_to_vec_of_floats(cx)?,
                    });
                }

                let options = options.build().map_err(|e| {
                    cx.throw_type_error::<_, TelemetryOptions>(format!(
                        "Failed to build prometheus exporter options: {:?}",
                        e
                    ))
                    .unwrap_err()
                })?;

                metrics_opts = Some(MetricsConfig::Prometheus(options));
            } else if let Some(ref otel) = js_optional_getter!(cx, metrics, "otel", JsObject) {
                let mut options = OtelCollectorOptionsBuilder::default();

                let url = js_value_getter!(cx, otel, "url", JsString);
                match Url::parse(&url) {
                    Ok(url) => options.url(url),
                    Err(e) => {
                        return cx.throw_type_error(format!(
                            "Invalid telemetryOptions.metrics.otel.url: {:?}",
                            e
                        ))?;
                    }
                };

                if js_value_getter!(cx, otel, "http", JsBoolean) {
                    options.protocol(OtlpProtocol::Http);
                } else {
                    options.protocol(OtlpProtocol::Grpc);
                }

                if let Some(ref headers) = js_optional_getter!(cx, otel, "headers", JsObject) {
                    options.headers(headers.as_hash_map_of_string_to_string(cx)?);
                };

                if let Some(metric_periodicity) =
                    js_optional_value_getter!(cx, otel, "metricsExportInterval", JsNumber)
                        .map(|f| f as u64)
                {
                    options.metric_periodicity(Duration::from_millis(metric_periodicity));
                }

                options.use_seconds_for_durations(js_value_getter!(
                    cx,
                    otel,
                    "useSecondsForDurations",
                    JsBoolean
                ));

                match js_value_getter!(cx, otel, "temporality", JsString).as_str() {
                    "cumulative" => options.metric_temporality(MetricTemporality::Cumulative),
                    "delta" => options.metric_temporality(MetricTemporality::Delta),
                    _ => {
                        return cx.throw_type_error("Invalid telemetryOptions.metrics.otel.temporality, expected 'cumulative' or 'delta'");
                    }
                };

                if let Some(global_tags) = global_tags {
                    options.global_tags(global_tags);
                }

                if let Some(histogram_bucket_overrides) =
                    js_optional_getter!(cx, otel, "histogramBucketOverrides", JsObject)
                {
                    options.histogram_bucket_overrides(HistogramBucketOverrides {
                        overrides: histogram_bucket_overrides
                            .as_hash_map_of_string_to_vec_of_floats(cx)?,
                    });
                }

                let options = options.build().map_err(|e| {
                    cx.throw_type_error::<_, TelemetryOptions>(format!(
                        "Failed to build otlp exporter options: {:?}",
                        e
                    ))
                    .unwrap_err()
                })?;

                metrics_opts = Some(MetricsConfig::Otel(options));
            } else {
                cx.throw_type_error(
                    "Invalid telemetryOptions.metrics, missing `prometheus` or `otel` option",
                )?
            }
        }

        Ok(RuntimeOptions {
            telemetry_options: telemetry_opts.build().map_err(|reason| {
                cx.throw_type_error::<_, TelemetryOptions>(format!("{:?}", reason))
                    .unwrap_err()
            })?,
            metrics_options: metrics_opts,
        })
    }
}

/////////////////

/// Request to drain forwarded logs from core
// FIXME: Implement log forwarding as push
pub fn poll_logs(mut cx: FunctionContext) -> JsResult<JsArray> {
    let runtime = cx.argument::<BoxedRuntimeRef>(0)?;
    let runtime_ref = runtime.borrow();
    let runtime_handle = runtime_ref
        .as_ref()
        .expect("Runtime has been shutdown")
        .clone();

    let logs = runtime_handle
        .core_runtime
        .telemetry()
        .fetch_buffered_logs();

    // FIXME: Serialize to JSON instead
    let logarr = cx.empty_array();
    for (i, cl) in logs.into_iter().enumerate() {
        // Not much to do here except for panic when there's an error here.
        let logobj = cx.empty_object();

        let level = cx.string(cl.level.to_string());
        logobj.set(&mut cx, "level", level).unwrap();

        let ts = system_time_to_js(&mut cx, &cl.timestamp).unwrap();
        logobj.set(&mut cx, "timestamp", ts).unwrap();

        let msg = cx.string(cl.message);
        logobj.set(&mut cx, "message", msg).unwrap();

        let fieldsobj = hashmap_to_js_value(&mut cx, cl.fields);
        logobj.set(&mut cx, "fields", fieldsobj.unwrap()).unwrap();

        let target = cx.string(cl.target);
        logobj.set(&mut cx, "target", target).unwrap();

        logarr.set(&mut cx, i as u32, logobj).unwrap();
    }

    Ok(logarr)
}

/// Helper to get the current time in nanosecond resolution. Nano seconds timestamps are
/// used to precisely sort logs emitted from the Workflow Context, main thread, and Core.
pub fn get_time_of_day(mut cx: FunctionContext) -> JsResult<JsBigInt> {
    system_time_to_js(&mut cx, &SystemTime::now())
}

fn system_time_to_js<'a, C>(cx: &mut C, time: &SystemTime) -> JsResult<'a, JsBigInt>
where
    C: Context<'a>,
{
    let nanos = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos();
    Ok(JsBigInt::from_u128(cx, nanos))
}
