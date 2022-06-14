use log::LevelFilter;
use neon::types::buffer::TypedArray;
use neon::{
    context::Context,
    handle::Handle,
    prelude::*,
    types::{JsBoolean, JsNumber, JsString},
};
use opentelemetry::trace::{SpanContext, SpanId, TraceFlags, TraceId, TraceState};
use std::{collections::HashMap, fmt::Display, net::SocketAddr, str::FromStr, time::Duration};
use temporal_sdk_core::{
    api::worker::{WorkerConfig, WorkerConfigBuilder},
    ClientOptions, ClientOptionsBuilder, ClientTlsConfig, Logger, MetricsExporter,
    OtelCollectorOptions, RetryConfig, TelemetryOptions, TelemetryOptionsBuilder, TlsConfig,
    TraceExporter, Url,
};

#[macro_export]
macro_rules! js_optional_getter {
    ($js_cx:expr, $js_obj:expr, $prop_name:expr, $js_type:ty) => {
        match get_optional($js_cx, $js_obj, $prop_name) {
            None => None,
            Some(val) => {
                if val.is_a::<$js_type, _>($js_cx) {
                    Some(val.downcast_or_throw::<$js_type, _>($js_cx)?)
                } else {
                    Some($js_cx.throw_type_error(format!("Invalid {}", $prop_name))?)
                }
            }
        }
    };
}

macro_rules! js_value_getter {
    ($js_cx:expr, $js_obj:expr, $prop_name:expr, $js_type:ty) => {
        match js_optional_getter!($js_cx, $js_obj, $prop_name, $js_type) {
            Some(val) => val.value($js_cx),
            None => $js_cx.throw_type_error(format!("{} must be defined", $prop_name))?,
        }
    };
}

/// Helper for extracting an optional attribute from [obj].
/// If [obj].[attr] is undefined or not present, None is returned
pub fn get_optional<'a, C, K>(
    cx: &mut C,
    obj: &Handle<JsObject>,
    attr: K,
) -> Option<Handle<'a, JsValue>>
where
    K: neon::object::PropertyKey,
    C: Context<'a>,
{
    match obj.get_value(cx, attr) {
        Err(_) => None,
        Ok(val) => match val.is_a::<JsUndefined, _>(cx) {
            true => None,
            false => Some(val),
        },
    }
}

/// Helper for extracting a Vec<u8> from optional Buffer at [obj].[attr]
fn get_optional_vec<'a, C, K>(
    cx: &mut C,
    obj: &Handle<JsObject>,
    attr: K,
) -> Result<Option<Vec<u8>>, neon::result::Throw>
where
    K: neon::object::PropertyKey + Display + Clone,
    C: Context<'a>,
{
    if let Some(val) = get_optional(cx, obj, attr.clone()) {
        let buf = val.downcast::<JsBuffer, C>(cx).map_err(|_| {
            cx.throw_type_error::<_, Option<Vec<u8>>>(format!("Invalid {}", attr))
                .unwrap_err()
        })?;
        Ok(Some(buf.as_slice(cx).to_vec()))
    } else {
        Ok(None)
    }
}

/// Helper for extracting a Vec<u8> from optional Buffer at [obj].[attr]
fn get_vec<'a, C, K>(
    cx: &mut C,
    obj: &Handle<JsObject>,
    attr: K,
    full_attr_path: &str,
) -> Result<Vec<u8>, neon::result::Throw>
where
    K: neon::object::PropertyKey + Display + Clone,
    C: Context<'a>,
{
    if let Some(val) = get_optional(cx, obj, attr.clone()) {
        let buf = val.downcast::<JsBuffer, C>(cx).map_err(|_| {
            cx.throw_type_error::<_, Option<Vec<u8>>>(format!("Invalid {}", attr))
                .unwrap_err()
        })?;
        Ok(buf.as_slice(cx).to_vec())
    } else {
        cx.throw_type_error::<_, Vec<u8>>(format!("Invalid or missing {}", full_attr_path))
    }
}

pub(crate) trait ObjectHandleConversionsExt {
    fn as_otel_span_context(&self, ctx: &mut FunctionContext) -> NeonResult<SpanContext>;
    fn as_client_options(&self, ctx: &mut FunctionContext) -> NeonResult<ClientOptions>;
    fn as_telemetry_options(&self, cx: &mut FunctionContext) -> NeonResult<TelemetryOptions>;
    fn as_worker_config(&self, cx: &mut FunctionContext) -> NeonResult<WorkerConfig>;
    fn as_hash_map_of_string_to_string(
        &self,
        cx: &mut FunctionContext,
    ) -> NeonResult<HashMap<String, String>>;
}

impl ObjectHandleConversionsExt for Handle<'_, JsObject> {
    fn as_otel_span_context(&self, ctx: &mut FunctionContext) -> NeonResult<SpanContext> {
        let trace_id = js_value_getter!(ctx, self, "traceId", JsString);
        let span_id = js_value_getter!(ctx, self, "spanId", JsString);
        let trace_flags = js_value_getter!(ctx, self, "traceFlags", JsNumber);
        Ok(SpanContext::new(
            TraceId::from_hex(&trace_id),
            SpanId::from_hex(&span_id),
            TraceFlags::new(trace_flags as u8),
            false,
            TraceState::from_str("").expect("Trace state must be valid"),
        ))
    }

    fn as_hash_map_of_string_to_string(
        &self,
        cx: &mut FunctionContext,
    ) -> NeonResult<HashMap<String, String>> {
        let props = self.get_own_property_names(cx)?;
        let props = props.to_vec(cx)?;
        let mut map = HashMap::new();
        for k in props {
            let k = k.to_string(cx)?;
            let v = self.get::<JsString, _, _>(cx, k)?.value(cx);
            let k = k.value(cx);
            map.insert(k, v);
        }
        Ok(map)
    }

    fn as_client_options(&self, cx: &mut FunctionContext) -> NeonResult<ClientOptions> {
        let url = match Url::parse(&js_value_getter!(cx, self, "url", JsString)) {
            Ok(url) => url,
            // Note that address is what's used in the Node side.
            Err(_) => cx.throw_type_error("Invalid serverOptions.address")?,
        };

        let tls_cfg = match js_optional_getter!(cx, self, "tls", JsObject) {
            None => None,
            Some(tls) => {
                let domain = js_optional_getter!(cx, &tls, "serverNameOverride", JsString)
                    .map(|h| h.value(cx));

                let server_root_ca_cert = get_optional_vec(cx, &tls, "serverRootCACertificate")?;
                let client_tls_config =
                    match js_optional_getter!(cx, &tls, "clientCertPair", JsObject) {
                        None => None,
                        Some(client_tls_obj) => Some(ClientTlsConfig {
                            client_cert: get_vec(
                                cx,
                                &client_tls_obj,
                                "crt",
                                "serverOptions.tls.clientCertPair.crt",
                            )?,
                            client_private_key: get_vec(
                                cx,
                                &client_tls_obj,
                                "key",
                                "serverOptions.tls.clientCertPair.crt",
                            )?,
                        }),
                    };

                Some(TlsConfig {
                    server_root_ca_cert,
                    domain,
                    client_tls_config,
                })
            }
        };

        let retry_config = match js_optional_getter!(cx, self, "retry", JsObject) {
            None => RetryConfig::default(),
            Some(ref retry_config) => RetryConfig {
                initial_interval: Duration::from_millis(js_value_getter!(
                    cx,
                    retry_config,
                    "initialInterval",
                    JsNumber
                ) as u64),
                randomization_factor: js_value_getter!(
                    cx,
                    retry_config,
                    "randomizationFactor",
                    JsNumber
                ),
                multiplier: js_value_getter!(cx, retry_config, "multiplier", JsNumber),
                max_interval: Duration::from_millis(js_value_getter!(
                    cx,
                    retry_config,
                    "maxInterval",
                    JsNumber
                ) as u64),
                max_elapsed_time: js_optional_getter!(
                    cx,
                    &retry_config,
                    "maxElapsedTime",
                    JsNumber
                )
                .map(|val| Duration::from_millis(val.value(cx) as u64)),
                max_retries: js_value_getter!(cx, retry_config, "maxRetries", JsNumber) as usize,
            },
        };

        let mut client_options = ClientOptionsBuilder::default();
        if let Some(tls_cfg) = tls_cfg {
            client_options.tls_cfg(tls_cfg);
        }

        Ok(client_options
            .client_name("temporal-typescript".to_string())
            .client_version(js_value_getter!(cx, self, "sdkVersion", JsString))
            .target_url(url)
            .retry_config(retry_config)
            .build()
            .expect("Core server gateway options must be valid"))
    }

    fn as_telemetry_options(&self, cx: &mut FunctionContext) -> NeonResult<TelemetryOptions> {
        let mut telemetry_opts = TelemetryOptionsBuilder::default();

        if let Some(tf) = js_optional_getter!(cx, self, "tracingFilter", JsString) {
            telemetry_opts.tracing_filter(tf.value(cx));
        }
        telemetry_opts.no_temporal_prefix_for_metrics(
            js_optional_getter!(cx, self, "noTemporalPrefixForMetrics", JsBoolean)
                .map(|b| b.value(cx))
                .unwrap_or_default(),
        );
        if let Some(ref logging) = js_optional_getter!(cx, self, "logging", JsObject) {
            if let Some(_) = get_optional(cx, logging, "console") {
                telemetry_opts.logging(Logger::Console);
            } else if let Some(ref forward) = js_optional_getter!(cx, logging, "forward", JsObject)
            {
                let level = js_value_getter!(cx, forward, "level", JsString);
                match LevelFilter::from_str(&level) {
                    Ok(level) => {
                        telemetry_opts.logging(Logger::Forward(level));
                    }
                    Err(err) => cx.throw_type_error(format!(
                        "Invalid telemetryOptions.logging.forward.level: {}",
                        err
                    ))?,
                }
            } else {
                cx.throw_type_error(format!(
                    "Invalid telemetryOptions.logging, missing `console` or `forward` option"
                ))?
            }
        }
        if let Some(metrics) = js_optional_getter!(cx, self, "metrics", JsObject) {
            if let Some(ref prom) = js_optional_getter!(cx, &metrics, "prometheus", JsObject) {
                let addr = js_value_getter!(cx, prom, "bindAddress", JsString);
                match addr.parse::<SocketAddr>() {
                    Ok(address) => telemetry_opts.metrics(MetricsExporter::Prometheus(address)),
                    Err(_) => cx.throw_type_error(
                        "Invalid telemetryOptions.metrics.prometheus.bindAddress",
                    )?,
                };
            } else if let Some(ref otel) = js_optional_getter!(cx, &metrics, "otel", JsObject) {
                let url = js_value_getter!(cx, otel, "url", JsString);
                let url = match Url::parse(&url) {
                    Ok(url) => url,
                    Err(_) => cx.throw_type_error("Invalid telemetryOptions.metrics.otel.url")?,
                };
                let headers =
                    if let Some(headers) = js_optional_getter!(cx, otel, "headers", JsObject) {
                        headers.as_hash_map_of_string_to_string(cx)?
                    } else {
                        Default::default()
                    };
                telemetry_opts
                    .metrics(MetricsExporter::Otel(OtelCollectorOptions { url, headers }));
            } else {
                cx.throw_type_error(format!(
                    "Invalid telemetryOptions.metrics, missing `prometheus` or `otel` option"
                ))?
            }
        }

        if let Some(tracing) = js_optional_getter!(cx, self, "tracing", JsObject) {
            if let Some(ref otel) = js_optional_getter!(cx, &tracing, "otel", JsObject) {
                let url = js_value_getter!(cx, otel, "url", JsString);
                let url = match Url::parse(&url) {
                    Ok(url) => url,
                    Err(_) => cx.throw_type_error("Invalid telemetryOptions.tracing.otel.url")?,
                };
                let headers =
                    if let Some(headers) = js_optional_getter!(cx, otel, "headers", JsObject) {
                        headers.as_hash_map_of_string_to_string(cx)?
                    } else {
                        Default::default()
                    };
                telemetry_opts.tracing(TraceExporter::Otel(OtelCollectorOptions { url, headers }));
            } else {
                cx.throw_type_error(format!(
                    "Invalid telemetryOptions.tracing, missing `otel` option"
                ))?
            }
        }
        telemetry_opts.build().map_err(|reason| {
            cx.throw_type_error::<_, TelemetryOptions>(format!("{}", reason))
                .unwrap_err()
        })
    }

    fn as_worker_config(&self, cx: &mut FunctionContext) -> NeonResult<WorkerConfig> {
        let namespace = js_value_getter!(cx, self, "namespace", JsString);
        let task_queue = js_value_getter!(cx, self, "taskQueue", JsString);
        let enable_remote_activities =
            js_value_getter!(cx, self, "enableNonLocalActivities", JsBoolean);
        let max_outstanding_activities =
            js_value_getter!(cx, self, "maxConcurrentActivityTaskExecutions", JsNumber) as usize;
        let max_outstanding_local_activities =
            js_value_getter!(cx, self, "maxConcurrentLocalActivityExecutions", JsNumber) as usize;
        let max_outstanding_workflow_tasks =
            js_value_getter!(cx, self, "maxConcurrentWorkflowTaskExecutions", JsNumber) as usize;
        let sticky_queue_schedule_to_start_timeout = Duration::from_millis(js_value_getter!(
            cx,
            self,
            "stickyQueueScheduleToStartTimeoutMs",
            JsNumber
        ) as u64);
        let max_cached_workflows =
            js_value_getter!(cx, self, "maxCachedWorkflows", JsNumber) as usize;

        let max_heartbeat_throttle_interval = Duration::from_millis(js_value_getter!(
            cx,
            self,
            "maxHeartbeatThrottleIntervalMs",
            JsNumber
        ) as u64);

        let default_heartbeat_throttle_interval = Duration::from_millis(js_value_getter!(
            cx,
            self,
            "defaultHeartbeatThrottleIntervalMs",
            JsNumber
        ) as u64);

        let max_worker_activities_per_second =
            js_optional_getter!(cx, self, "maxActivitiesPerSecond", JsNumber)
                .map(|num| num.value(cx) as f64);
        let max_task_queue_activities_per_second =
            js_optional_getter!(cx, self, "maxTaskQueueActivitiesPerSecond", JsNumber)
                .map(|num| num.value(cx) as f64);

        match WorkerConfigBuilder::default()
            .worker_build_id(js_value_getter!(cx, self, "buildId", JsString))
            .client_identity_override(Some(js_value_getter!(cx, self, "identity", JsString)))
            .no_remote_activities(!enable_remote_activities)
            .max_outstanding_workflow_tasks(max_outstanding_workflow_tasks)
            .max_outstanding_activities(max_outstanding_activities)
            .max_outstanding_local_activities(max_outstanding_local_activities)
            .max_cached_workflows(max_cached_workflows)
            .sticky_queue_schedule_to_start_timeout(sticky_queue_schedule_to_start_timeout)
            .namespace(namespace)
            .task_queue(task_queue)
            .max_heartbeat_throttle_interval(max_heartbeat_throttle_interval)
            .default_heartbeat_throttle_interval(default_heartbeat_throttle_interval)
            .max_worker_activities_per_second(max_worker_activities_per_second)
            .max_task_queue_activities_per_second(max_task_queue_activities_per_second)
            .build()
        {
            Ok(worker_cfg) => Ok(worker_cfg),
            Err(e) => cx.throw_error(format!("Invalid worker config: {:?}", e)),
        }
    }
}
