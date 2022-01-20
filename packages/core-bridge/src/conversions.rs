use log::LevelFilter;
use neon::{
    context::Context,
    handle::Handle,
    prelude::*,
    types::{JsNumber, JsString},
};
use opentelemetry::trace::{SpanContext, SpanId, TraceFlags, TraceId, TraceState};
use std::{fmt::Display, net::SocketAddr, str::FromStr, time::Duration};
use temporal_sdk_core::{
    api::worker::{WorkerConfig, WorkerConfigBuilder},
    ClientTlsConfig, RetryConfig, ServerGatewayOptions, ServerGatewayOptionsBuilder,
    TelemetryOptions, TelemetryOptionsBuilder, TlsConfig, Url,
};

macro_rules! js_value_getter {
    ($js_cx:expr, $js_obj:ident, $prop_name:expr, $js_type:ty) => {
        $js_obj
            .get($js_cx, $prop_name)?
            .downcast::<$js_type, _>($js_cx)
            .map_err(|_| {
                $js_cx
                    .throw_type_error::<_, Option<Vec<u8>>>(format!("Invalid {}", $prop_name))
                    .unwrap_err()
            })?
            .value($js_cx)
    };
}

macro_rules! js_optional_getter {
    ($js_cx:expr, $js_obj:expr, $prop_name:expr, $js_type:ty) => {
        match get_optional($js_cx, $js_obj, $prop_name) {
            Some(val) => Some(val.downcast::<$js_type, _>($js_cx).map_err(|_| {
                $js_cx
                    .throw_type_error::<_, Option<Vec<u8>>>(format!("Invalid {}", $prop_name))
                    .unwrap_err()
            })?),
            None => None,
        }
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
    K: neon::object::PropertyKey + Display + Clone,
    C: Context<'a>,
{
    if let Some(val) = get_optional(cx, obj, attr.clone()) {
        let buf = val.downcast::<JsBuffer, C>(cx).map_err(|_| {
            cx.throw_type_error::<_, Option<Vec<u8>>>(format!("Invalid {}", attr))
                .unwrap_err()
        })?;
        Ok(Some(cx.borrow(&buf, |data| data.as_slice::<u8>().to_vec())))
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
        Ok(cx.borrow(&buf, |data| data.as_slice::<u8>().to_vec()))
    } else {
        cx.throw_type_error::<_, Vec<u8>>(format!("Invalid or missing {}", full_attr_path))
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
            Some(retry_config) => RetryConfig {
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

        let mut gateway_opts = ServerGatewayOptionsBuilder::default();
        if let Some(tls_cfg) = tls_cfg {
            gateway_opts.tls_cfg(tls_cfg);
        }
        Ok(gateway_opts
            .client_name("temporal-typescript".to_string())
            .client_version(js_value_getter!(cx, self, "sdkVersion", JsString))
            .target_url(url)
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
        if let Some(url) = js_optional_getter!(cx, self, "oTelCollectorUrl", JsString) {
            let url = match Url::parse(&url.value(cx)) {
                Ok(url) => url,
                Err(_) => cx.throw_type_error("Invalid telemetryOptions.oTelCollectorUrl")?,
            };
            telemetry_opts.otel_collector_url(url);
        }
        if let Some(addr) = js_optional_getter!(cx, self, "prometheusMetricsBindAddress", JsString)
        {
            match addr.value(cx).parse::<SocketAddr>() {
                Ok(address) => telemetry_opts.prometheus_export_bind_address(address),
                Err(_) => {
                    cx.throw_type_error("Invalid telemetryOptions.prometheusMetricsBindAddress")?
                }
            };
        }
        if let Some(tf) = js_optional_getter!(cx, self, "tracingFilter", JsString) {
            telemetry_opts.tracing_filter(tf.value(cx));
        }
        telemetry_opts
            .log_forwarding_level(log_forwarding_level)
            .build()
            .map_err(|reason| {
                cx.throw_type_error::<_, TelemetryOptions>(format!("{}", reason))
                    .unwrap_err()
            })
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

        match WorkerConfigBuilder::default()
            .no_remote_activities(false) // TODO: make this configurable once Core implements local activities
            .max_concurrent_at_polls(max_concurrent_at_polls)
            .max_concurrent_wft_polls(max_concurrent_wft_polls)
            .max_outstanding_workflow_tasks(max_outstanding_workflow_tasks)
            .max_outstanding_activities(max_outstanding_activities)
            .max_cached_workflows(max_cached_workflows)
            .nonsticky_to_sticky_poll_ratio(nonsticky_to_sticky_poll_ratio)
            .sticky_queue_schedule_to_start_timeout(sticky_queue_schedule_to_start_timeout)
            .task_queue(task_queue)
            .max_heartbeat_throttle_interval(max_heartbeat_throttle_interval)
            .default_heartbeat_throttle_interval(default_heartbeat_throttle_interval)
            .max_outstanding_local_activities(10_usize) // TODO: Pass in
            .build()
        {
            Ok(worker_cfg) => Ok(worker_cfg),
            Err(e) => cx.throw_error(format!("Invalid worker config: {:?}", e)),
        }
    }
}
