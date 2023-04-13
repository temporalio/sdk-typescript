use crate::helpers::*;
use neon::{
    context::Context,
    handle::Handle,
    prelude::*,
    types::{JsBoolean, JsNumber, JsString},
};
use opentelemetry::trace::{SpanContext, SpanId, TraceFlags, TraceId, TraceState};
use std::{collections::HashMap, net::SocketAddr, str::FromStr, time::Duration};
use temporal_sdk_core::{
    api::telemetry::{
        Logger, MetricTemporality, MetricsExporter, OtelCollectorOptions, TelemetryOptions,
        TelemetryOptionsBuilder, TraceExportConfig, TraceExporter,
    },
    api::worker::{WorkerConfig, WorkerConfigBuilder},
    ephemeral_server::{
        TemporalDevServerConfig, TemporalDevServerConfigBuilder, TestServerConfig,
        TestServerConfigBuilder,
    },
    ClientOptions, ClientOptionsBuilder, ClientTlsConfig, RetryConfig, TlsConfig, Url,
};

pub enum EphemeralServerConfig {
    TestServer(TestServerConfig),
    DevServer(TemporalDevServerConfig),
}

pub trait ArrayHandleConversionsExt {
    fn to_vec_of_string(&self, cx: &mut FunctionContext) -> NeonResult<Vec<String>>;
}

impl ArrayHandleConversionsExt for Handle<'_, JsArray> {
    fn to_vec_of_string(&self, cx: &mut FunctionContext) -> NeonResult<Vec<String>> {
        let js_vec = self.to_vec(cx)?;
        let len = js_vec.len();
        let mut ret_vec = Vec::<String>::with_capacity(len);

        for i in 0..len - 1 {
            ret_vec[i] = js_vec[i].downcast_or_throw::<JsString, _>(cx)?.value(cx);
        }
        Ok(ret_vec)
    }
}

pub trait ObjectHandleConversionsExt {
    fn set_default(&self, cx: &mut FunctionContext, key: &str, value: &str) -> NeonResult<()>;
    fn as_otel_span_context(&self, ctx: &mut FunctionContext) -> NeonResult<SpanContext>;
    fn as_client_options(&self, ctx: &mut FunctionContext) -> NeonResult<ClientOptions>;
    fn as_telemetry_options(&self, cx: &mut FunctionContext) -> NeonResult<TelemetryOptions>;
    fn as_worker_config(&self, cx: &mut FunctionContext) -> NeonResult<WorkerConfig>;
    fn as_ephemeral_server_config(
        &self,
        cx: &mut FunctionContext,
        sdk_version: String,
    ) -> NeonResult<EphemeralServerConfig>;
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
            TraceId::from_hex(&trace_id).expect("TraceId is valid"),
            SpanId::from_hex(&span_id).expect("SpanId is valid"),
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
                let domain = js_optional_value_getter!(cx, &tls, "serverNameOverride", JsString);

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
                max_elapsed_time: js_optional_value_getter!(
                    cx,
                    retry_config,
                    "maxElapsedTime",
                    JsNumber
                )
                .map(|val| Duration::from_millis(val as u64)),
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
        telemetry_opts.no_temporal_prefix_for_metrics(
            js_optional_value_getter!(cx, self, "noTemporalPrefixForMetrics", JsBoolean)
                .unwrap_or_default(),
        );

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
            if let Some(temporality) =
                js_optional_value_getter!(cx, metrics, "temporality", JsString)
            {
                match temporality.as_str() {
                    "cumulative" => {
                        telemetry_opts.metric_temporality(MetricTemporality::Cumulative);
                    }
                    "delta" => {
                        telemetry_opts.metric_temporality(MetricTemporality::Delta);
                    }
                    _ => {
                        cx.throw_type_error("Invalid telemetryOptions.metrics.temporality, expected 'cumulative' or 'delta'")?;
                    }
                };
            }
            if let Some(ref prom) = js_optional_getter!(cx, metrics, "prometheus", JsObject) {
                let addr = js_value_getter!(cx, prom, "bindAddress", JsString);
                match addr.parse::<SocketAddr>() {
                    Ok(address) => telemetry_opts.metrics(MetricsExporter::Prometheus(address)),
                    Err(_) => cx.throw_type_error(
                        "Invalid telemetryOptions.metrics.prometheus.bindAddress",
                    )?,
                };
            } else if let Some(ref otel) = js_optional_getter!(cx, metrics, "otel", JsObject) {
                let url = js_value_getter!(cx, otel, "url", JsString);
                let url = match Url::parse(&url) {
                    Ok(url) => url,
                    Err(_) => cx.throw_type_error("Invalid telemetryOptions.metrics.otel.url")?,
                };
                let headers =
                    if let Some(ref headers) = js_optional_getter!(cx, otel, "headers", JsObject) {
                        headers.as_hash_map_of_string_to_string(cx)?
                    } else {
                        Default::default()
                    };
                let metric_periodicity = Some(Duration::from_millis(js_value_getter!(
                    cx,
                    otel,
                    "metricsExportInterval",
                    JsNumber
                ) as u64));
                telemetry_opts.metrics(MetricsExporter::Otel(OtelCollectorOptions {
                    url,
                    headers,
                    metric_periodicity,
                }));
            } else {
                cx.throw_type_error(
                    "Invalid telemetryOptions.metrics, missing `prometheus` or `otel` option",
                )?
            }
        }

        if let Some(ref tracing) = js_optional_getter!(cx, self, "tracing", JsObject) {
            let filter = js_value_getter!(cx, tracing, "filter", JsString);
            if let Some(ref otel) = js_optional_getter!(cx, tracing, "otel", JsObject) {
                let url = js_value_getter!(cx, otel, "url", JsString);
                let url = match Url::parse(&url) {
                    Ok(url) => url,
                    Err(_) => cx.throw_type_error("Invalid telemetryOptions.tracing.otel.url")?,
                };
                let headers =
                    if let Some(ref headers) = js_optional_getter!(cx, otel, "headers", JsObject) {
                        headers.as_hash_map_of_string_to_string(cx)?
                    } else {
                        Default::default()
                    };
                telemetry_opts.tracing(TraceExportConfig {
                    filter,
                    exporter: TraceExporter::Otel(OtelCollectorOptions {
                        url,
                        headers,
                        metric_periodicity: None,
                    }),
                });
            } else {
                cx.throw_type_error("Invalid telemetryOptions.tracing, missing `otel` option")?
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

        let graceful_shutdown_period =
            js_optional_getter!(cx, self, "shutdownGraceTimeMs", JsNumber)
                .map(|num| Duration::from_millis(num.value(cx) as u64));

        match WorkerConfigBuilder::default()
            .worker_build_id(js_value_getter!(cx, self, "buildId", JsString))
            .client_identity_override(Some(js_value_getter!(cx, self, "identity", JsString)))
            .no_remote_activities(!enable_remote_activities)
            .max_outstanding_workflow_tasks(max_outstanding_workflow_tasks)
            .max_outstanding_activities(max_outstanding_activities)
            .max_outstanding_local_activities(max_outstanding_local_activities)
            .max_cached_workflows(max_cached_workflows)
            .sticky_queue_schedule_to_start_timeout(sticky_queue_schedule_to_start_timeout)
            .graceful_shutdown_period(graceful_shutdown_period)
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

    fn set_default(&self, cx: &mut FunctionContext, key: &str, value: &str) -> NeonResult<()> {
        let key = cx.string(key);
        let existing: Option<Handle<JsString>> = self.get_opt(cx, key)?;
        if existing.is_none() {
            let value = cx.string(value);
            self.set(cx, key, value)?;
        }
        Ok(())
    }

    fn as_ephemeral_server_config(
        &self,
        cx: &mut FunctionContext,
        sdk_version: String,
    ) -> NeonResult<EphemeralServerConfig> {
        let js_executable = js_optional_getter!(cx, self, "executable", JsObject)
            .unwrap_or_else(|| cx.empty_object());
        js_executable.set_default(cx, "type", "cached-download")?;

        let exec_type = js_value_getter!(cx, &js_executable, "type", JsString);
        let executable = match exec_type.as_str() {
            "cached-download" => {
                let version = js_optional_value_getter!(cx, &js_executable, "version", JsString)
                    .unwrap_or_else(|| "default".to_owned());
                let dest_dir =
                    js_optional_value_getter!(cx, &js_executable, "downloadDir", JsString);

                let exec_version = match version.as_str() {
                    "default" => {
                        temporal_sdk_core::ephemeral_server::EphemeralExeVersion::SDKDefault {
                            sdk_name: "sdk-typescript".to_owned(),
                            sdk_version,
                        }
                    }
                    _ => temporal_sdk_core::ephemeral_server::EphemeralExeVersion::Fixed(version),
                };
                temporal_sdk_core::ephemeral_server::EphemeralExe::CachedDownload {
                    version: exec_version,
                    dest_dir,
                }
            }
            "existing-path" => {
                let path = js_value_getter!(cx, &js_executable, "path", JsString);
                temporal_sdk_core::ephemeral_server::EphemeralExe::ExistingPath(path)
            }
            _ => {
                return cx.throw_type_error(format!("Invalid executable type: {}", exec_type))?;
            }
        };
        let port = js_optional_getter!(cx, self, "port", JsNumber).map(|s| s.value(cx) as u16);

        let server_type = js_value_getter!(cx, self, "type", JsString);
        match server_type.as_str() {
            "dev-server" => {
                let mut config = TemporalDevServerConfigBuilder::default();
                config.exe(executable).port(port);

                if let Some(extra_args) = js_optional_getter!(cx, self, "extraArgs", JsArray) {
                    config.extra_args(extra_args.to_vec_of_string(cx)?);
                };
                if let Some(namespace) = js_optional_value_getter!(cx, self, "namespace", JsString)
                {
                    config.namespace(namespace);
                }
                if let Some(ip) = js_optional_value_getter!(cx, self, "ip", JsString) {
                    config.ip(ip);
                }
                config.db_filename(js_optional_value_getter!(cx, self, "dbFilename", JsString));
                config.ui(js_optional_value_getter!(cx, self, "ui", JsBoolean).unwrap_or_default());

                if let Some(log) = js_optional_getter!(cx, self, "log", JsObject) {
                    let format = js_value_getter!(cx, &log, "format", JsString);
                    let level = js_value_getter!(cx, &log, "level", JsString);
                    config.log((format, level));
                }

                match config.build() {
                    Ok(config) => Ok(EphemeralServerConfig::DevServer(config)),
                    Err(err) => {
                        cx.throw_type_error(format!("Invalid dev server config: {:?}", err))
                    }
                }
            }
            "time-skipping" => {
                let mut config = TestServerConfigBuilder::default();
                config.exe(executable).port(port);

                if let Some(extra_args_js) = js_optional_getter!(cx, self, "extraArgs", JsArray) {
                    let extra_args = extra_args_js.to_vec_of_string(cx)?;
                    config.extra_args(extra_args);
                };

                match config.build() {
                    Ok(config) => Ok(EphemeralServerConfig::TestServer(config)),
                    Err(err) => {
                        cx.throw_type_error(format!("Invalid test server config: {:?}", err))
                    }
                }
            }
            s => cx.throw_type_error(format!(
                "Invalid ephemeral server type: {}, expected 'dev-server' or 'time-skipping'",
                s
            )),
        }
    }
}
