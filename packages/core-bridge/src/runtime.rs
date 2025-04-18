use std::{sync::Arc, time::Duration};

use anyhow::Context as _;
use futures::channel::mpsc::Receiver;
use neon::prelude::*;

use temporal_sdk_core::{
    CoreRuntime, TokioRuntimeBuilder,
    api::telemetry::{
        CoreLog, OtelCollectorOptions as CoreOtelCollectorOptions,
        PrometheusExporterOptions as CorePrometheusExporterOptions, metrics::CoreMeter,
    },
    telemetry::{build_otlp_metric_exporter, start_prometheus_metric_exporter},
};

use bridge_macros::js_function;
use tokio_stream::StreamExt as _;

use crate::{helpers::*, logs::LogEntry};

////////////////////////////////////////////////////////////////////////////////////////////////////

pub struct Runtime {
    // Public because it's accessed from all other modules
    #[allow(clippy::struct_field_names)]
    pub(crate) core_runtime: Arc<CoreRuntime>,

    log_exporter_task: Option<Arc<tokio::task::JoinHandle<()>>>,
    metrics_exporter_task: Option<Arc<tokio::task::AbortHandle>>,

    // For some unknown reason, the otel metrics exporter will go crazy on shutdown in some
    // scenarios if we don't hold on to the `CoreOtelMeter` till the `Runtime` finally gets dropped.
    _otel_metrics_exporter: Option<Arc<dyn CoreMeter + 'static>>,
}

impl Finalize for Runtime {}

////////////////////////////////////////////////////////////////////////////////////////////////////

pub fn init(cx: &mut neon::prelude::ModuleContext) -> neon::prelude::NeonResult<()> {
    cx.export_function("newRuntime", runtime_new)?;
    cx.export_function("runtimeShutdown", runtime_shutdown)?;

    Ok(())
}

/// Initialize Core global telemetry and create the tokio runtime required to run Core.
/// This should typically be called once on process startup.
#[js_function]
pub fn runtime_new(
    bridge_options: config::RuntimeOptions,
) -> BridgeResult<OpaqueOutboundHandle<Runtime>> {
    let (telemetry_options, metrics_options, logging_options) = bridge_options.try_into()?;

    // Create core runtime which starts tokio multi-thread runtime
    let mut core_runtime = CoreRuntime::new(telemetry_options, TokioRuntimeBuilder::default())
        .context("Failed to initialize Core Runtime")?;

    let _guard = core_runtime.tokio_handle().enter();

    // Run the metrics exporter task, if needed
    // Created after Core runtime since it needs Tokio handle
    let (prom_metrics_exporter_task, otel_metrics_exporter) = match metrics_options {
        Some(BridgeMetricsExporter::Prometheus(prom_opts)) => {
            let exporter = start_prometheus_metric_exporter(prom_opts)
                .context("Failed to start prometheus metrics exporter")?;

            core_runtime
                .telemetry_mut()
                .attach_late_init_metrics(exporter.meter);

            (Some(exporter.abort_handle), None)
        }
        Some(BridgeMetricsExporter::Otel(otel_opts)) => {
            let exporter = build_otlp_metric_exporter(otel_opts)
                .context("Failed to start OTel metrics exporter")?;

            let exporter: Arc<dyn CoreMeter + 'static> = Arc::new(exporter);
            core_runtime
                .telemetry_mut()
                .attach_late_init_metrics(exporter.clone());

            (None, Some(exporter))
        }
        None => (None, None),
    };

    // Run the log exporter task, if needed
    // Created after Core runtime since it needs Tokio handle
    let log_exporter_task = if let BridgeLogExporter::Push { stream, receiver } = logging_options {
        let log_exporter_task = Arc::new(core_runtime.tokio_handle().spawn(async move {
            let mut stream = std::pin::pin!(stream.chunks_timeout(
                config::FORWARD_LOG_BUFFER_SIZE,
                Duration::from_millis(config::FORWARD_LOG_MAX_FREQ_MS)
            ));

            while let Some(core_logs) = stream.next().await {
                // We silently swallow errors here because logging them could
                // cause a bad loop and we don't want to assume console presence
                let core_logs = core_logs
                    .into_iter()
                    .filter_map(|log| JsonString::<LogEntry>::try_from(log).ok())
                    .collect::<Vec<_>>();
                let _ = receiver.call_on_js_thread((core_logs,));
            }
        }));
        Some(log_exporter_task)
    } else {
        None
    };

    Ok(OpaqueOutboundHandle::new(Runtime {
        core_runtime: Arc::new(core_runtime),
        log_exporter_task,
        metrics_exporter_task: prom_metrics_exporter_task.map(Arc::new),
        _otel_metrics_exporter: otel_metrics_exporter,
    }))
}

/// Stops the bridge runtime. In practice, this simply drops the RuntimeHandle out of the
/// BoxedRuntimeRef, and is therefore almost the same as just waiting for the lang-side GC
/// to drop the JS counterpart of BoxedRuntimeRef, but this function gives us a bit more
/// control on when that happens (b/c we don't have to wait for the JS GC), which is useful
/// when starting/stopping runtimes at a high pace, e.g. during tests execution.
#[js_function]
pub fn runtime_shutdown(runtime: OpaqueInboundHandle<Runtime>) -> BridgeResult<()> {
    std::mem::drop(runtime.take_inner()?);
    Ok(())
}

impl Drop for Runtime {
    fn drop(&mut self) {
        if let Some(handle) = self.log_exporter_task.take() {
            handle.abort();
        }

        if let Some(handle) = self.metrics_exporter_task.take() {
            handle.abort();
        }
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

#[macro_export]
macro_rules! enter_sync {
    ($runtime:expr) => {
        if let Some(subscriber) = $runtime.telemetry().trace_subscriber() {
            temporal_sdk_core::telemetry::set_trace_subscriber_for_current_thread(subscriber);
        }
        let _guard = $runtime.tokio_handle().enter();
    };
}

pub trait RuntimeExt {
    fn future_to_promise<F, R>(&self, future: F) -> BridgeResult<BridgeFuture<R>>
    where
        F: Future<Output = Result<R, BridgeError>> + Send + 'static,
        R: TryIntoJs + Send + 'static;
}

impl RuntimeExt for CoreRuntime {
    fn future_to_promise<F, R>(&self, future: F) -> BridgeResult<BridgeFuture<R>>
    where
        F: Future<Output = Result<R, BridgeError>> + Send + 'static,
        R: TryIntoJs + Send + 'static,
    {
        enter_sync!(self);
        Ok(BridgeFuture::new(Box::pin(future)))
    }
}

impl RuntimeExt for Arc<CoreRuntime> {
    fn future_to_promise<F, R>(&self, future: F) -> BridgeResult<BridgeFuture<R>>
    where
        F: Future<Output = Result<R, BridgeError>> + Send + 'static,
        R: TryIntoJs + Send + 'static,
    {
        self.as_ref().future_to_promise(future)
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

#[derive(Debug, Clone)]
pub enum BridgeMetricsExporter {
    Prometheus(CorePrometheusExporterOptions),
    Otel(CoreOtelCollectorOptions),
}

pub enum BridgeLogExporter {
    Console,
    Push {
        stream: Receiver<CoreLog>,
        receiver: JsCallback<(Vec<JsonString<LogEntry>>,), ()>,
    },
}

////////////////////////////////////////////////////////////////////////////////////////////////////

// IMORTANT: Any struct or enum below this point must be kept in sync with the type of the same name
//           in native.ts. Similarly,

mod config {
    use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::Duration};

    use anyhow::Context as _;

    use neon::prelude::*;
    use temporal_sdk_core::{
        Url,
        api::telemetry::{
            HistogramBucketOverrides, Logger as CoreTelemetryLogger, MetricTemporality,
            OtelCollectorOptions as CoreOtelCollectorOptions, OtelCollectorOptionsBuilder,
            OtlpProtocol, PrometheusExporterOptions as CorePrometheusExporterOptions,
            PrometheusExporterOptionsBuilder, TelemetryOptions as CoreTelemetryOptions,
            TelemetryOptionsBuilder,
        },
        telemetry::CoreLogStreamConsumer,
    };

    use bridge_macros::TryFromJs;

    use crate::{
        helpers::{BridgeError, BridgeResult, JsCallback, JsonString, TryFromJs},
        logs::LogEntry,
    };

    use super::BridgeLogExporter;

    pub(super) const FORWARD_LOG_BUFFER_SIZE: usize = 2048;
    pub(super) const FORWARD_LOG_MAX_FREQ_MS: u64 = 10;

    #[derive(Debug, Clone, TryFromJs)]
    pub(super) struct RuntimeOptions {
        log_exporter: LogExporter,
        telemetry: TelemetryOptions,
        metrics_exporter: Option<MetricsExporter>,
    }

    impl
        TryInto<(
            CoreTelemetryOptions,
            Option<super::BridgeMetricsExporter>,
            super::BridgeLogExporter,
        )> for RuntimeOptions
    {
        type Error = BridgeError;

        fn try_into(
            self,
        ) -> BridgeResult<(
            CoreTelemetryOptions,
            Option<super::BridgeMetricsExporter>,
            super::BridgeLogExporter,
        )> {
            let (telemetry_logger, log_exporter) = match self.log_exporter {
                LogExporter::Console { filter } => (
                    CoreTelemetryLogger::Console { filter },
                    BridgeLogExporter::Console,
                ),
                LogExporter::Forward { filter, receiver } => {
                    let (consumer, stream) = CoreLogStreamConsumer::new(FORWARD_LOG_BUFFER_SIZE);
                    (
                        CoreTelemetryLogger::Push {
                            filter,
                            consumer: Arc::new(consumer),
                        },
                        BridgeLogExporter::Push { stream, receiver },
                    )
                }
            };

            let mut telemetry_options = TelemetryOptionsBuilder::default();
            let telemetry_options = telemetry_options
                .logging(telemetry_logger)
                .metric_prefix(self.telemetry.metric_prefix)
                .attach_service_name(self.telemetry.attach_service_name)
                .build()
                .context("Failed to build telemetry options")?;

            let metrics_exporter = self
                .metrics_exporter
                .map(std::convert::TryInto::try_into)
                .transpose()?;

            Ok((telemetry_options, metrics_exporter, log_exporter))
        }
    }

    #[derive(Debug, Clone, TryFromJs)]
    pub(super) struct TelemetryOptions {
        metric_prefix: String,
        attach_service_name: bool,
    }

    #[derive(Debug, Clone, TryFromJs)]
    pub(super) enum LogExporter {
        Console {
            filter: String,
        },
        Forward {
            filter: String,
            receiver: JsCallback<(Vec<JsonString<LogEntry>>,), ()>,
        },
    }

    #[derive(Debug, Clone, TryFromJs)]
    pub(super) enum MetricsExporter {
        Prometheus(PrometheusConfig),
        Otel(OtelConfig),
    }

    #[derive(Debug, Clone, TryFromJs)]
    pub(super) struct PrometheusConfig {
        bind_address: SocketAddr,
        counters_total_suffix: bool,
        unit_suffix: bool,
        use_seconds_for_durations: bool,
        histogram_bucket_overrides: HashMap<String, Vec<f64>>,
        global_tags: HashMap<String, String>,
    }

    impl TryInto<super::BridgeMetricsExporter> for MetricsExporter {
        type Error = BridgeError;
        fn try_into(self) -> BridgeResult<super::BridgeMetricsExporter> {
            match self {
                Self::Prometheus(prom) => {
                    Ok(super::BridgeMetricsExporter::Prometheus(prom.try_into()?))
                }
                Self::Otel(otel) => Ok(super::BridgeMetricsExporter::Otel(otel.try_into()?)),
            }
        }
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
    pub(super) struct OtelConfig {
        url: Url,
        protocol: StringEncoded<OtlpProtocol>,
        headers: HashMap<String, String>,
        metrics_export_interval: Duration,
        use_seconds_for_durations: bool,
        temporality: StringEncoded<MetricTemporality>,
        histogram_bucket_overrides: HashMap<String, Vec<f64>>,
        global_tags: HashMap<String, String>,
    }

    impl TryInto<CoreOtelCollectorOptions> for OtelConfig {
        type Error = BridgeError;

        fn try_into(self) -> BridgeResult<CoreOtelCollectorOptions> {
            let mut options = OtelCollectorOptionsBuilder::default();
            let options = options
                .url(self.url)
                .protocol(*self.protocol)
                .headers(self.headers)
                .metric_periodicity(self.metrics_export_interval)
                .use_seconds_for_durations(self.use_seconds_for_durations)
                .metric_temporality(*self.temporality)
                .histogram_bucket_overrides(HistogramBucketOverrides {
                    overrides: self.histogram_bucket_overrides,
                })
                .global_tags(self.global_tags)
                .build()
                .context("Failed to build otel exporter options")?;

            Ok(options)
        }
    }

    /// A private newtype so that we can implement `TryFromJs` on simple externally defined enums
    #[derive(Debug, Clone)]
    struct StringEncoded<T>(T);

    impl TryFromJs for StringEncoded<OtlpProtocol> {
        fn try_from_js<'cx, 'b>(
            cx: &mut impl Context<'cx>,
            js_value: Handle<'b, JsValue>,
        ) -> BridgeResult<Self> {
            let value = js_value.downcast::<JsString, _>(cx)?;
            let value = value.value(cx);

            match value.as_str() {
                "http" => Ok(Self(OtlpProtocol::Http)),
                "grpc" => Ok(Self(OtlpProtocol::Grpc)),
                _ => Err(BridgeError::TypeError {
                    field: None,
                    message: "Expected either 'http' or 'grpc'".to_string(),
                }),
            }
        }
    }

    impl TryFromJs for StringEncoded<MetricTemporality> {
        fn try_from_js<'cx, 'b>(
            cx: &mut impl Context<'cx>,
            js_value: Handle<'b, JsValue>,
        ) -> BridgeResult<Self> {
            let value = js_value.downcast::<JsString, _>(cx)?;
            let value = value.value(cx);

            match value.as_str() {
                "cumulative" => Ok(Self(MetricTemporality::Cumulative)),
                "delta" => Ok(Self(MetricTemporality::Delta)),
                _ => Err(BridgeError::TypeError {
                    field: None,
                    message: "Expected either 'cumulative' or 'delta'".to_string(),
                }),
            }
        }
    }

    impl<T> std::ops::Deref for StringEncoded<T> {
        type Target = T;
        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }
}
