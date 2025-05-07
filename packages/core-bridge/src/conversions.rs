use crate::helpers::*;
use neon::{
    context::Context,
    handle::Handle,
    prelude::*,
    types::{JsBoolean, JsNumber, JsString},
};
use slot_supplier_bridge::SlotSupplierBridge;
use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::Duration};
use temporal_client::HttpConnectProxyOptions;
use temporal_sdk_core::api::worker::SlotKind;
use temporal_sdk_core::{
    api::telemetry::{Logger, MetricTemporality, TelemetryOptions, TelemetryOptionsBuilder},
    api::{
        telemetry::{
            metrics::CoreMeter, OtelCollectorOptionsBuilder, PrometheusExporterOptionsBuilder,
        },
        worker::{WorkerConfig, WorkerConfigBuilder},
    },
    ephemeral_server::{
        TemporalDevServerConfig, TemporalDevServerConfigBuilder, TestServerConfig,
        TestServerConfigBuilder,
    },
    telemetry::{build_otlp_metric_exporter, start_prometheus_metric_exporter},
    ClientOptions, ClientOptionsBuilder, ClientTlsConfig, ResourceBasedSlotsOptions,
    ResourceBasedSlotsOptionsBuilder, ResourceSlotOptions, RetryConfig, SlotSupplierOptions,
    TlsConfig, TunerHolderOptionsBuilder, Url,
};

mod slot_supplier_bridge;

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

        for i in js_vec.iter().take(len) {
            ret_vec.push(i.downcast_or_throw::<JsString, _>(cx)?.value(cx));
        }
        Ok(ret_vec)
    }
}

type BoxedMeterMaker = Box<dyn FnOnce() -> Result<Arc<dyn CoreMeter>, String> + Send + Sync>;

pub(crate) type TelemOptsRes = (TelemetryOptions, Option<BoxedMeterMaker>);

pub(crate) trait ObjectHandleConversionsExt {
    fn set_default(&self, cx: &mut FunctionContext, key: &str, value: &str) -> NeonResult<()>;
    fn as_client_options(&self, ctx: &mut FunctionContext) -> NeonResult<ClientOptions>;
    fn as_telemetry_options(&self, cx: &mut FunctionContext) -> NeonResult<TelemOptsRes>;
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
    fn into_slot_supplier<SK: SlotKind + Send + Sync + 'static>(
        self,
        cx: &mut FunctionContext,
        rbo: &mut Option<ResourceBasedSlotsOptions>,
    ) -> NeonResult<SlotSupplierOptions<SK>>;
}

impl ObjectHandleConversionsExt for Handle<'_, JsObject> {
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

        let proxy_cfg = match js_optional_getter!(cx, self, "proxy", JsObject) {
            None => None,
            Some(proxy) => {
                let target_addr = js_value_getter!(cx, &proxy, "targetHost", JsString);

                let basic_auth = match js_optional_getter!(cx, &proxy, "basicAuth", JsObject) {
                    None => None,
                    Some(proxy_obj) => Some((
                        js_value_getter!(cx, &proxy_obj, "username", JsString),
                        js_value_getter!(cx, &proxy_obj, "password", JsString),
                    )),
                };

                Some(HttpConnectProxyOptions {
                    target_addr,
                    basic_auth,
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
        client_options.http_connect_proxy(proxy_cfg);
        let headers = match js_optional_getter!(cx, self, "metadata", JsObject) {
            None => None,
            Some(h) => Some(h.as_hash_map_of_string_to_string(cx).map_err(|reason| {
                cx.throw_type_error::<_, HashMap<String, String>>(format!(
                    "Invalid metadata: {}",
                    reason
                ))
                .unwrap_err()
            })?),
        };
        client_options.headers(headers);
        let api_key = js_optional_value_getter!(cx, self, "apiKey", JsString);
        client_options.api_key(api_key);

        Ok(client_options
            .client_name("temporal-typescript".to_string())
            .client_version(js_value_getter!(cx, self, "sdkVersion", JsString))
            .target_url(url)
            .retry_config(retry_config)
            .build()
            .expect("Core server gateway options must be valid"))
    }

    fn as_telemetry_options(&self, cx: &mut FunctionContext) -> NeonResult<TelemOptsRes> {
        let mut telemetry_opts = TelemetryOptionsBuilder::default();
        if js_optional_value_getter!(cx, self, "noTemporalPrefixForMetrics", JsBoolean)
            .unwrap_or_default()
        {
            telemetry_opts.metric_prefix("".to_string());
        }

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

        let mut meter_maker = None;

        if let Some(ref metrics) = js_optional_getter!(cx, self, "metrics", JsObject) {
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

                if let Some(counters_total_suffix) =
                    js_optional_value_getter!(cx, prom, "countersTotalSuffix", JsBoolean)
                {
                    options.counters_total_suffix(counters_total_suffix);
                }
                if let Some(unit_suffix) =
                    js_optional_value_getter!(cx, prom, "unitSuffix", JsBoolean)
                {
                    options.unit_suffix(unit_suffix);
                }
                if let Some(use_seconds_for_durations) =
                    js_optional_value_getter!(cx, prom, "useSecondsForDurations", JsBoolean)
                {
                    options.use_seconds_for_durations(use_seconds_for_durations);
                }

                let options = options.build().map_err(|e| {
                    cx.throw_type_error::<_, TelemetryOptions>(format!(
                        "Failed to build prometheus exporter options: {:?}",
                        e
                    ))
                    .unwrap_err()
                })?;

                meter_maker =
                    Some(
                        Box::new(move || match start_prometheus_metric_exporter(options) {
                            Ok(prom_info) => Ok(prom_info.meter as Arc<dyn CoreMeter>),
                            Err(e) => Err(format!("Failed to start prometheus exporter: {}", e)),
                        }) as BoxedMeterMaker,
                    );
            } else if let Some(ref otel) = js_optional_getter!(cx, metrics, "otel", JsObject) {
                let mut options = OtelCollectorOptionsBuilder::default();

                let url = js_value_getter!(cx, otel, "url", JsString);
                match Url::parse(&url) {
                    Ok(url) => options.url(url),
                    Err(e) => {
                        return cx.throw_type_error(format!(
                            "Invalid telemetryOptions.metrics.otel.url: {}",
                            e
                        ))?;
                    }
                };

                if let Some(use_seconds_for_durations) =
                    js_optional_value_getter!(cx, otel, "useSecondsForDurations", JsBoolean)
                {
                    options.use_seconds_for_durations(use_seconds_for_durations);
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

                // FIXME: Move temporality to the otel object
                if let Some(temporality) =
                    js_optional_value_getter!(cx, metrics, "temporality", JsString)
                {
                    match temporality.as_str() {
                        "cumulative" => options.metric_temporality(MetricTemporality::Cumulative),
                        "delta" => options.metric_temporality(MetricTemporality::Delta),
                        _ => {
                            return cx.throw_type_error("Invalid telemetryOptions.metrics.temporality, expected 'cumulative' or 'delta'");
                        }
                    };
                };

                let options = options.build().map_err(|e| {
                    cx.throw_type_error::<_, TelemetryOptions>(format!(
                        "Failed to build otlp exporter options: {:?}",
                        e
                    ))
                    .unwrap_err()
                })?;

                meter_maker = Some(Box::new(move || match build_otlp_metric_exporter(options) {
                    Ok(otlp_exporter) => Ok(Arc::new(otlp_exporter) as Arc<dyn CoreMeter>),
                    Err(e) => Err(format!("Failed to start otlp exporter: {}", e)),
                }) as BoxedMeterMaker);
            } else {
                cx.throw_type_error(
                    "Invalid telemetryOptions.metrics, missing `prometheus` or `otel` option",
                )?
            }
        }

        Ok((
            telemetry_opts.build().map_err(|reason| {
                cx.throw_type_error::<_, TelemetryOptions>(format!("{}", reason))
                    .unwrap_err()
            })?,
            meter_maker,
        ))
    }

    fn as_worker_config(&self, cx: &mut FunctionContext) -> NeonResult<WorkerConfig> {
        let namespace = js_value_getter!(cx, self, "namespace", JsString);
        let task_queue = js_value_getter!(cx, self, "taskQueue", JsString);
        let enable_remote_activities =
            js_value_getter!(cx, self, "enableNonLocalActivities", JsBoolean);
        let max_concurrent_wft_polls =
            js_value_getter!(cx, self, "maxConcurrentWorkflowTaskPolls", JsNumber) as usize;
        let max_concurrent_at_polls =
            js_value_getter!(cx, self, "maxConcurrentActivityTaskPolls", JsNumber) as usize;
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
                .map(|num| num.value(cx));
        let max_task_queue_activities_per_second =
            js_optional_getter!(cx, self, "maxTaskQueueActivitiesPerSecond", JsNumber)
                .map(|num| num.value(cx));

        let graceful_shutdown_period =
            js_optional_getter!(cx, self, "shutdownGraceTimeMs", JsNumber)
                .map(|num| Duration::from_millis(num.value(cx) as u64));

        let nonsticky_to_sticky_poll_ratio =
            js_value_getter!(cx, self, "nonStickyToStickyPollRatio", JsNumber) as f32;

        let tuner = if let Some(tuner) = js_optional_getter!(cx, self, "tuner", JsObject) {
            let mut tuner_holder = TunerHolderOptionsBuilder::default();
            let mut rbo = None;

            if let Some(wf_slot_supp) =
                js_optional_getter!(cx, &tuner, "workflowTaskSlotSupplier", JsObject)
            {
                tuner_holder.workflow_slot_options(wf_slot_supp.into_slot_supplier(cx, &mut rbo)?);
            }
            if let Some(act_slot_supp) =
                js_optional_getter!(cx, &tuner, "activityTaskSlotSupplier", JsObject)
            {
                tuner_holder.activity_slot_options(act_slot_supp.into_slot_supplier(cx, &mut rbo)?);
            }
            if let Some(local_act_slot_supp) =
                js_optional_getter!(cx, &tuner, "localActivityTaskSlotSupplier", JsObject)
            {
                tuner_holder.local_activity_slot_options(
                    local_act_slot_supp.into_slot_supplier(cx, &mut rbo)?,
                );
            }
            if let Some(rbo) = rbo {
                tuner_holder.resource_based_options(rbo);
            }
            match tuner_holder.build_tuner_holder() {
                Err(e) => {
                    return cx.throw_error(format!("Invalid tuner options: {:?}", e));
                }
                Ok(th) => Arc::new(th),
            }
        } else {
            return cx.throw_error("Missing tuner");
        };

        match WorkerConfigBuilder::default()
            .worker_build_id(js_value_getter!(cx, self, "buildId", JsString))
            .client_identity_override(Some(js_value_getter!(cx, self, "identity", JsString)))
            .use_worker_versioning(js_value_getter!(cx, self, "useVersioning", JsBoolean))
            .no_remote_activities(!enable_remote_activities)
            .tuner(tuner)
            .max_concurrent_wft_polls(max_concurrent_wft_polls)
            .max_concurrent_at_polls(max_concurrent_at_polls)
            .nonsticky_to_sticky_poll_ratio(nonsticky_to_sticky_poll_ratio)
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
                    ttl: None,
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

    fn into_slot_supplier<SK: SlotKind + Send + Sync + 'static>(
        self,
        cx: &mut FunctionContext,
        rbo: &mut Option<ResourceBasedSlotsOptions>,
    ) -> NeonResult<SlotSupplierOptions<SK>> {
        match js_value_getter!(cx, &self, "type", JsString).as_str() {
            "fixed-size" => Ok(SlotSupplierOptions::FixedSize {
                slots: js_value_getter!(cx, &self, "numSlots", JsNumber) as usize,
            }),
            "resource-based" => {
                let min_slots = js_value_getter!(cx, &self, "minimumSlots", JsNumber);
                let max_slots = js_value_getter!(cx, &self, "maximumSlots", JsNumber);
                let ramp_throttle = js_value_getter!(cx, &self, "rampThrottleMs", JsNumber) as u64;
                if let Some(tuner_opts) = js_optional_getter!(cx, &self, "tunerOptions", JsObject) {
                    let target_mem =
                        js_value_getter!(cx, &tuner_opts, "targetMemoryUsage", JsNumber);
                    let target_cpu = js_value_getter!(cx, &tuner_opts, "targetCpuUsage", JsNumber);
                    *rbo = Some(
                        ResourceBasedSlotsOptionsBuilder::default()
                            .target_cpu_usage(target_cpu)
                            .target_mem_usage(target_mem)
                            .build()
                            .expect("Building ResourceBasedSlotsOptions can't fail"),
                    )
                } else {
                    return cx
                        .throw_type_error("Resource based slot supplier requires tunerOptions");
                };
                Ok(SlotSupplierOptions::ResourceBased(
                    ResourceSlotOptions::new(
                        min_slots as usize,
                        max_slots as usize,
                        Duration::from_millis(ramp_throttle),
                    ),
                ))
            }
            "custom" => {
                let ssb = SlotSupplierBridge::new(cx, self)?;
                Ok(SlotSupplierOptions::Custom(Arc::new(ssb)))
            }
            _ => cx.throw_type_error("Invalid slot supplier type"),
        }
    }
}
