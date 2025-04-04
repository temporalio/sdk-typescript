use std::{cell::RefCell, sync::Arc, time::SystemTime};

use anyhow::Context as AnyhowContext;
use bridge_macros::js_function;
use neon::{context::Context as NeonContext, prelude::*};
use temporal_sdk_core::{
    CoreRuntime, TokioRuntimeBuilder,
    api::telemetry::{CoreLog, CoreTelemetry},
    telemetry::{build_otlp_metric_exporter, start_prometheus_metric_exporter},
};

use crate::helpers::{
    BridgeError, BridgeResult, IntoThrow, TryFromJs, TryIntoJs, conversions::hashmap_to_js_value,
};

////////////////////////////////////////////////////////////////////////////////////////////////////

/// This is the type that we actually pass to the lang side.
///
/// - JsBox: So that we're informed if the object is dropped by the lang GC
/// - RefCell: For interior mutability
/// - Option: So that we can take it out of the box on shutdown (requires mutability ^^^)
/// - RuntimeHandle: The actual runtime handle (below)
pub type BoxedRuntimeRef = JsBox<RefCell<Option<RuntimeHandle>>>;

#[derive(Clone)]
pub struct RuntimeHandle {
    pub(crate) core_runtime: Arc<CoreRuntime>,
}

impl Finalize for RuntimeHandle {}

impl TryFromJs for RuntimeHandle {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let runtime = js_value.downcast::<BoxedRuntimeRef, _>(cx)?;
        let runtime = runtime.borrow();
        Ok(runtime
            .as_ref()
            .ok_or(BridgeError::IllegalStateAlreadyClosed { what: "Runtime" })?
            .clone())
    }
}

impl TryIntoJs for RuntimeHandle {
    type Output = BoxedRuntimeRef;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, BoxedRuntimeRef> {
        Ok(cx.boxed(RefCell::new(Some(self.clone()))))
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

/// Initialize Core global telemetry and create the tokio runtime required to run Core.
/// This should typically be called once on process startup.
#[js_function]
pub fn runtime_new(bridge_options: config::RuntimeOptions) -> BridgeResult<RuntimeHandle> {
    let (telemetry_options, metrics_options) = bridge_options.try_into()?;

    // Create core runtime which starts tokio multi-thread runtime
    let mut core_runtime = CoreRuntime::new(telemetry_options, TokioRuntimeBuilder::default())
        .context("Failed to initialize Core Runtime")?;

    let _guard = core_runtime.tokio_handle().enter();

    // Create metrics (created after Core runtime since it needs Tokio handle)
    match metrics_options {
        Some(config::CoreMetricsExporter::Prometheus(prom_opts)) => {
            let exporter = start_prometheus_metric_exporter(prom_opts)
                .context("Failed to start prometheus metrics exporter")?;

            core_runtime
                .telemetry_mut()
                .attach_late_init_metrics(exporter.meter);
        }
        Some(config::CoreMetricsExporter::Otel(otel_opts)) => {
            let exporter = build_otlp_metric_exporter(otel_opts)
                .context("Failed to start OTel metrics exporter")?;

            core_runtime
                .telemetry_mut()
                .attach_late_init_metrics(Arc::new(exporter));
        }
        None => {}
    }

    // FIXME: Implement log forwarding as push (we currently do it as pull)

    Ok(RuntimeHandle {
        core_runtime: Arc::new(core_runtime),
    })
}

/// Stops the bridge runtime. In practice, this simply drops the RuntimeHandle out of the
/// BoxedRuntimeRef, and is therefore almost the same as just waiting for the lang-side GC
/// to drop the JS counterpart of BoxedRuntimeRef, but this one gives us a bit more control
/// on when that happens, which is particulary useful during testing.
pub fn runtime_shutdown(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let runtime = cx.argument::<BoxedRuntimeRef>(0)?;

    runtime_shutdown_impl(runtime).into_throw(&mut cx)?;
    Ok(cx.undefined())
}

// #[js_function]
// FIXME: Adapt the js_function macro so that we don't need this manual implementation
fn runtime_shutdown_impl(
    runtime: Handle<JsBox<RefCell<Option<RuntimeHandle>>>>,
) -> BridgeResult<()> {
    if runtime.take().is_none() {
        Err(BridgeError::IllegalStateAlreadyClosed { what: "Runtime" })
    } else {
        Ok(())
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

mod config {
    use std::{collections::HashMap, net::SocketAddr, time::Duration};

    use anyhow::Context as AnyhowContext;
    use bridge_macros::TryFromJs;
    use temporal_sdk_core::{
        Url,
        api::telemetry::{
            HistogramBucketOverrides, Logger, MetricTemporality,
            OtelCollectorOptions as CoreOtelCollectorOptions, OtelCollectorOptionsBuilder,
            OtlpProtocol, PrometheusExporterOptions as CorePrometheusExporterOptions,
            PrometheusExporterOptionsBuilder, TelemetryOptions as CoreTelemetryOptions,
            TelemetryOptionsBuilder,
        },
    };

    use crate::helpers::{BridgeError, BridgeResult};

    #[derive(Debug, Clone)]
    pub(crate) enum CoreMetricsExporter {
        Prometheus(CorePrometheusExporterOptions),
        Otel(CoreOtelCollectorOptions),
    }

    #[derive(Debug, Clone, TryFromJs)]
    pub struct RuntimeOptions {
        pub(crate) log_exporter: LogExporter,
        pub(crate) telemetry: TelemetryOptions,
        pub(crate) metrics_exporter: Option<MetricsExporter>,
    }

    impl TryInto<(CoreTelemetryOptions, Option<CoreMetricsExporter>)> for RuntimeOptions {
        type Error = BridgeError;

        fn try_into(self) -> BridgeResult<(CoreTelemetryOptions, Option<CoreMetricsExporter>)> {
            let log_exporter = match self.log_exporter {
                LogExporter::Console { filter } => Logger::Console { filter },
                LogExporter::Forward { filter } => Logger::Forward { filter },
            };

            let mut telemetry_options = TelemetryOptionsBuilder::default();
            let telemetry_options = telemetry_options
                .logging(log_exporter)
                .metric_prefix(self.telemetry.metric_prefix)
                .attach_service_name(self.telemetry.attach_service_name)
                .build()
                .context("Failed to build telemetry options")?;

            let metrics_exporter = self
                .metrics_exporter
                .map(|config| config.try_into())
                .transpose()?;

            Ok((telemetry_options, metrics_exporter))
        }
    }

    #[derive(Debug, Clone, TryFromJs)]
    pub(crate) struct TelemetryOptions {
        pub(crate) metric_prefix: String,
        pub(crate) attach_service_name: bool,
    }

    #[derive(Debug, Clone, TryFromJs)]
    pub(crate) enum LogExporter {
        Console { filter: String },
        Forward { filter: String },
    }

    #[derive(Debug, Clone, TryFromJs)]
    pub(crate) enum MetricsExporter {
        Prometheus(PrometheusConfig),
        Otel(OtelConfig),
    }

    impl TryInto<CoreMetricsExporter> for MetricsExporter {
        type Error = BridgeError;

        fn try_into(self) -> BridgeResult<CoreMetricsExporter> {
            match self {
                MetricsExporter::Prometheus(prom) => {
                    Ok(CoreMetricsExporter::Prometheus(prom.try_into()?))
                }
                MetricsExporter::Otel(otel) => Ok(CoreMetricsExporter::Otel(otel.try_into()?)),
            }
        }
    }

    #[derive(Debug, Clone, TryFromJs)]
    pub(crate) struct PrometheusConfig {
        pub(crate) bind_address: SocketAddr,
        pub(crate) counters_total_suffix: bool,
        pub(crate) unit_suffix: bool,
        pub(crate) use_seconds_for_durations: bool,
        pub(crate) histogram_bucket_overrides: HashMap<String, Vec<f64>>,
        pub(crate) global_tags: HashMap<String, String>,
    }

    impl TryInto<CorePrometheusExporterOptions> for PrometheusConfig {
        type Error = BridgeError;

        fn try_into(self) -> BridgeResult<CorePrometheusExporterOptions> {
            let mut options = PrometheusExporterOptionsBuilder::default();
            let options = options
                .socket_addr(self.bind_address)
                .counters_total_suffix(self.counters_total_suffix)
                .unit_suffix(self.unit_suffix)
                .use_seconds_for_durations(self.use_seconds_for_durations)
                .histogram_bucket_overrides(HistogramBucketOverrides {
                    overrides: self.histogram_bucket_overrides,
                })
                .global_tags(self.global_tags)
                .build()
                .context("Failed to build prometheus exporter options")?;

            Ok(options)
        }
    }

    #[derive(Debug, Clone, TryFromJs)]
    pub(crate) struct OtelConfig {
        pub(crate) url: Url,
        pub(crate) http: bool,
        pub(crate) headers: HashMap<String, String>,
        pub(crate) metrics_export_interval: Duration,
        pub(crate) use_seconds_for_durations: bool,
        pub(crate) temporality: String,
        pub(crate) histogram_bucket_overrides: HashMap<String, Vec<f64>>,
        pub(crate) global_tags: HashMap<String, String>,
    }

    impl TryInto<CoreOtelCollectorOptions> for OtelConfig {
        type Error = BridgeError;

        fn try_into(self) -> BridgeResult<CoreOtelCollectorOptions> {
            let mut options = OtelCollectorOptionsBuilder::default();
            let options = options
                .url(self.url)
                // FIXME: Use converter
                .protocol(if self.http {
                    OtlpProtocol::Http
                } else {
                    OtlpProtocol::Grpc
                })
                .headers(self.headers)
                .metric_periodicity(self.metrics_export_interval)
                .use_seconds_for_durations(self.use_seconds_for_durations)
                // FIXME: Use converter
                .metric_temporality(match self.temporality.as_str() {
                    "cumulative" => MetricTemporality::Cumulative,
                    "delta" => MetricTemporality::Delta,
                    _ => {
                        return Err(BridgeError::TypeError {
                            field: Some("otel.temporality".to_string()),
                            message: "Expected either 'cumulative' or 'delta'".to_string(),
                        });
                    }
                })
                .histogram_bucket_overrides(HistogramBucketOverrides {
                    overrides: self.histogram_bucket_overrides,
                })
                .global_tags(self.global_tags)
                .build()
                .context("Failed to build otel exporter options")?;

            Ok(options)
        }
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

/// Request to drain forwarded logs from core
// FIXME: Implement log forwarding as push
#[js_function]
pub fn poll_logs(runtime: RuntimeHandle) -> BridgeResult<Vec<CoreLog>> {
    Ok(runtime.core_runtime.telemetry().fetch_buffered_logs())
}

impl TryIntoJs for CoreLog {
    type Output = JsObject;

    // FIXME: Move to macro
    // FIXME: Use `try_into_js` everywhere
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsObject> {
        let logobj = cx.empty_object();

        let level = cx.string(self.level.to_string());
        logobj.set(cx, "level", level).unwrap();

        let ts = self.timestamp.try_into_js(cx)?;
        logobj.set(cx, "timestamp", ts).unwrap();

        let msg = cx.string(self.message.clone());
        logobj.set(cx, "message", msg).unwrap();

        let fieldsobj = hashmap_to_js_value(cx, self.fields.clone());
        logobj.set(cx, "fields", fieldsobj.unwrap()).unwrap();

        let target = cx.string(self.target.clone());
        logobj.set(cx, "target", target).unwrap();

        Ok(logobj)
    }
}

/// Helper to get the current time in nanosecond resolution. Nano seconds timestamps are
/// used to precisely sort logs emitted from the Workflow Context, main thread, and Core.
#[js_function]
pub fn get_time_of_day() -> BridgeResult<SystemTime> {
    Ok(SystemTime::now())
}
