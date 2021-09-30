use log::LevelFilter;
use neon::{
    context::Context,
    handle::Handle,
    prelude::*,
    types::{JsNumber, JsString},
};
use opentelemetry::trace::{SpanContext, SpanId, TraceFlags, TraceId, TraceState};
use std::net::SocketAddr;
use std::{fmt::Display, str::FromStr, time::Duration};
use temporal_sdk_core::{
    ClientTlsConfig, RetryConfig, ServerGatewayOptions, ServerGatewayOptionsBuilder,
    TelemetryOptions, TelemetryOptionsBuilder, TlsConfig, Url, WorkerConfig,
};

macro_rules! js_value_getter {
    ($js_cx:expr, $js_obj:ident, $prop_name:expr, $js_type:ty) => {
        $js_obj
            .get($js_cx, $prop_name)?
            .downcast_or_throw::<$js_type, _>($js_cx)?
            .value($js_cx)
    };
}

/// Helper for extracting an optional attribute from [obj].
/// If [obj].[attr] is undefined or not present, None is returned
fn get_optional<'a, C, K>(
    cx: &mut C,
    obj: &Handle<JsObject>,
    attr: K,
) -> Option<Handle<'a, JsValue>>
where
    K: neon::object::PropertyKey,
    C: Context<'a>,
{
    match obj.get(cx, attr) {
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
    K: neon::object::PropertyKey + Display,
    C: Context<'a>,
{
    if let Some(val) = get_optional(cx, obj, attr) {
        let buf = val.downcast_or_throw::<JsBuffer, C>(cx)?;
        Ok(Some(cx.borrow(&buf, |data| data.as_slice::<u8>().to_vec())))
    } else {
        Ok(None)
    }
}

pub(crate) trait ObjectHandleConversionsExt {
    fn as_otel_span_context(&self, ctx: &mut FunctionContext) -> NeonResult<SpanContext>;
    fn as_server_gateway_options(
        &self,
        ctx: &mut FunctionContext,
    ) -> NeonResult<ServerGatewayOptions>;
    fn as_telemetry_options(&self, cx: &mut FunctionContext) -> NeonResult<TelemetryOptions>;
    fn as_worker_config(&self, cx: &mut FunctionContext) -> NeonResult<WorkerConfig>;
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

    fn as_server_gateway_options(
        &self,
        cx: &mut FunctionContext,
    ) -> NeonResult<ServerGatewayOptions> {
        let url = js_value_getter!(cx, self, "url", JsString);

        let tls_cfg = match get_optional(cx, self, "tls") {
            None => None,
            Some(val) => {
                let tls = val.downcast_or_throw::<JsObject, _>(cx)?;
                let domain = match get_optional(cx, &tls, "serverNameOverride") {
                    None => None,
                    Some(val) => Some(val.downcast_or_throw::<JsString, _>(cx)?.value(cx)),
                };

                let server_root_ca_cert = get_optional_vec(cx, &tls, "serverRootCACertificate")?;
                let client_tls_config = match get_optional(cx, &tls, "clientCertPair") {
                    None => None,
                    Some(val) => {
                        let client_tls_obj = val.downcast_or_throw::<JsObject, _>(cx)?;
                        Some(ClientTlsConfig {
                            client_cert: get_optional_vec(cx, &client_tls_obj, "crt")?.unwrap(),
                            client_private_key: get_optional_vec(cx, &client_tls_obj, "key")?
                                .unwrap(),
                        })
                    }
                };

                Some(TlsConfig {
                    server_root_ca_cert,
                    domain,
                    client_tls_config,
                })
            }
        };

        let retry_config = match get_optional(cx, self, "retry") {
            None => RetryConfig::default(),
            Some(val) => {
                let retry_config = val.downcast_or_throw::<JsObject, _>(cx)?;
                RetryConfig {
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
                    max_elapsed_time: match get_optional(cx, &retry_config, "maxElapsedTime") {
                        None => None,
                        Some(val) => {
                            let val = val.downcast_or_throw::<JsNumber, _>(cx)?;
                            Some(Duration::from_millis(val.value(cx) as u64))
                        }
                    },
                    max_retries: js_value_getter!(cx, retry_config, "maxRetries", JsNumber)
                        as usize,
                }
            }
        };

        let mut gateway_opts = ServerGatewayOptionsBuilder::default();
        if let Some(tls_cfg) = tls_cfg {
            gateway_opts.tls_cfg(tls_cfg);
        }
        Ok(gateway_opts
            .client_name("temporal-sdk-node".to_string())
            .client_version(js_value_getter!(cx, self, "sdkVersion", JsString))
            .target_url(Url::parse(&url).unwrap())
            .namespace(js_value_getter!(cx, self, "namespace", JsString))
            .identity(js_value_getter!(cx, self, "identity", JsString))
            .worker_binary_id(js_value_getter!(cx, self, "workerBinaryId", JsString))
            .retry_config(retry_config)
            .build()
            .expect("Core server gateway options must be valid"))
    }

    fn as_telemetry_options(&self, cx: &mut FunctionContext) -> NeonResult<TelemetryOptions> {
        let log_forwarding_level_str =
            js_value_getter!(cx, self, "logForwardingLevel", JsString).replace("WARNING", "WARN");
        let log_forwarding_level =
            LevelFilter::from_str(&log_forwarding_level_str).unwrap_or(LevelFilter::Off);
        let mut telemetry_opts = TelemetryOptionsBuilder::default();
        if let Some(url) = get_optional(cx, self, "oTelCollectorUrl") {
            telemetry_opts.otel_collector_url(
                Url::parse(&url.downcast_or_throw::<JsString, _>(cx).unwrap().value(cx))
                    .expect("`oTelCollectorUrl` in telemetry options must be valid"),
            );
        }
        if let Some(addr) = get_optional(cx, self, "prometheusMetricsBindAddress") {
            telemetry_opts.prometheus_export_bind_address(
                addr.downcast_or_throw::<JsString, _>(cx)
                    .unwrap()
                    .value(cx)
                    .parse::<SocketAddr>()
                    .expect("`prometheusMetricsBindAddress` in telemetry options must be valid"),
            );
        }
        Ok(telemetry_opts
            .tracing_filter(
                get_optional(cx, self, "tracingFilter")
                    .map(|x| x.downcast_or_throw::<JsString, _>(cx).unwrap().value(cx))
                    .unwrap_or_else(|| "".to_string()),
            )
            .log_forwarding_level(log_forwarding_level)
            .build()
            .expect("Core telemetry options must be valid"))
    }

    fn as_worker_config(&self, cx: &mut FunctionContext) -> NeonResult<WorkerConfig> {
        let task_queue = js_value_getter!(cx, self, "taskQueue", JsString);
        let max_outstanding_activities =
            js_value_getter!(cx, self, "maxConcurrentActivityTaskExecutions", JsNumber) as usize;
        let max_outstanding_workflow_tasks =
            js_value_getter!(cx, self, "maxConcurrentWorkflowTaskExecutions", JsNumber) as usize;
        let max_concurrent_wft_polls =
            js_value_getter!(cx, self, "maxConcurrentWorkflowTaskPolls", JsNumber) as usize;
        let max_concurrent_at_polls =
            js_value_getter!(cx, self, "maxConcurrentActivityTaskPolls", JsNumber) as usize;
        let nonsticky_to_sticky_poll_ratio =
            js_value_getter!(cx, self, "nonStickyToStickyPollRatio", JsNumber) as f32;
        let sticky_queue_schedule_to_start_timeout = Duration::from_millis(js_value_getter!(
            cx,
            self,
            "stickyQueueScheduleToStartTimeoutMs",
            JsNumber
        ) as u64);
        let max_cached_workflows =
            js_value_getter!(cx, self, "maxCachedWorkflows", JsNumber) as usize;
        Ok(WorkerConfig {
            no_remote_activities: false, // TODO: make this configurable once Core implements local activities
            max_concurrent_at_polls,
            max_concurrent_wft_polls,
            max_outstanding_workflow_tasks,
            max_outstanding_activities,
            max_cached_workflows,
            nonsticky_to_sticky_poll_ratio,
            sticky_queue_schedule_to_start_timeout,
            task_queue,
        })
    }
}
