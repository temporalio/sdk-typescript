use std::any::Any;
use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Context as _;
use neon::prelude::*;
use serde::Deserialize;

use temporalio_common::telemetry::metrics::{
    BufferInstrumentRef as CoreBufferInstrumentRef, CoreMeter, Counter as CoreCounter,
    CustomMetricAttributes, Gauge as CoreGauge, Histogram as CoreHistogram, MetricCallBufferer,
    MetricEvent as CoreMetricEvent, MetricKind as CoreMetricKind,
    MetricParameters as CoreMetricParameters, MetricParametersBuilder, NewAttributes,
    TemporalMeter,
};
use temporalio_common::telemetry::metrics::{
    GaugeF64 as CoreGaugeF64, HistogramF64 as CoreHistogramF64,
};
use temporalio_common::telemetry::{
    metrics,
    metrics::{MetricKeyValue as CoreMetricKeyValue, MetricValue as CoreMetricValue},
};

use bridge_macros::{TryIntoJs, js_function};
use temporalio_sdk_core::telemetry::MetricsCallBuffer as CoreMetricsCallBuffer;

use crate::helpers::properties::ObjectExt as _;
use crate::helpers::try_into_js::{MemoizedHandle, OptionAsUndefined};
use crate::helpers::{
    BridgeError, BridgeResult, JsonString, MutableFinalize, OpaqueInboundHandle,
    OpaqueOutboundHandle, TryIntoJs,
};
use crate::runtime::Runtime;

////////////////////////////////////////////////////////////////////////////////////////////////////
// Metric Meter (aka Custom Metrics)
////////////////////////////////////////////////////////////////////////////////////////////////////

pub fn init(cx: &mut neon::prelude::ModuleContext) -> neon::prelude::NeonResult<()> {
    cx.export_function("newMetricCounter", new_metric_counter)?;
    cx.export_function("newMetricHistogram", new_metric_histogram)?;
    cx.export_function("newMetricHistogramF64", new_metric_histogram_f64)?;
    cx.export_function("newMetricGauge", new_metric_gauge)?;
    cx.export_function("newMetricGaugeF64", new_metric_gauge_f64)?;

    cx.export_function("addMetricCounterValue", add_metric_counter_value)?;
    cx.export_function("recordMetricHistogramValue", record_metric_histogram_value)?;
    cx.export_function(
        "recordMetricHistogramF64Value",
        record_metric_histogram_f64_value,
    )?;
    cx.export_function("setMetricGaugeValue", set_metric_gauge_value)?;
    cx.export_function("setMetricGaugeF64Value", set_metric_gauge_f64_value)?;

    Ok(())
}

pub struct Counter {
    pub(crate) meter: TemporalMeter,
    pub(crate) counter: CoreCounter,
}

impl MutableFinalize for Counter {}

pub struct Histogram {
    pub(crate) meter: TemporalMeter,
    pub(crate) histogram: CoreHistogram,
}
impl MutableFinalize for Histogram {}

pub struct HistogramF64 {
    pub(crate) meter: TemporalMeter,
    pub(crate) histogram: CoreHistogramF64,
}
impl MutableFinalize for HistogramF64 {}

pub struct Gauge {
    pub(crate) meter: TemporalMeter,
    pub(crate) gauge: CoreGauge,
}
impl MutableFinalize for Gauge {}

pub struct GaugeF64 {
    pub(crate) meter: TemporalMeter,
    pub(crate) gauge: CoreGaugeF64,
}
impl MutableFinalize for GaugeF64 {}

#[derive(Debug, Deserialize)]
pub struct MetricAttributes {
    #[serde(flatten)]
    pub attributes: HashMap<String, MetricValue>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum MetricValue {
    Int(i64),
    Float(f64),
    Bool(bool),
    String(String),
}

impl From<MetricValue> for CoreMetricValue {
    fn from(value: MetricValue) -> Self {
        match value {
            MetricValue::Int(i) => Self::Int(i),
            MetricValue::Float(f) => Self::Float(f),
            MetricValue::Bool(b) => Self::Bool(b),
            MetricValue::String(s) => Self::String(s),
        }
    }
}

/// Create a new metric counter
#[js_function]
pub fn new_metric_counter(
    runtime: OpaqueInboundHandle<Runtime>,
    name: String,
    unit: String,
    description: String,
) -> BridgeResult<OpaqueOutboundHandle<Counter>> {
    let core_runtime = runtime.borrow()?.core_runtime.clone();
    let meter = core_runtime
        .telemetry()
        .get_metric_meter()
        .ok_or(BridgeError::UnexpectedError(
            "Failed to get metric meter".into(),
        ))?;

    let counter = meter.inner.counter(
        MetricParametersBuilder::default()
            .name(name)
            .unit(unit)
            .description(description)
            .build()
            .context("Failed to build metric parameters")?,
    );

    Ok(OpaqueOutboundHandle::new(Counter { meter, counter }))
}

#[js_function]
pub fn new_metric_histogram(
    runtime: OpaqueInboundHandle<Runtime>,
    name: String,
    unit: String,
    description: String,
) -> BridgeResult<OpaqueOutboundHandle<Histogram>> {
    let core_runtime = runtime.borrow()?.core_runtime.clone();
    let meter = core_runtime
        .telemetry()
        .get_metric_meter()
        .ok_or(BridgeError::UnexpectedError(
            "Failed to get metric meter".into(),
        ))?;

    let histogram = meter.inner.histogram(
        MetricParametersBuilder::default()
            .name(name)
            .unit(unit)
            .description(description)
            .build()
            .context("Failed to build metric parameters")?,
    );

    Ok(OpaqueOutboundHandle::new(Histogram { meter, histogram }))
}

#[js_function]
pub fn new_metric_histogram_f64(
    runtime: OpaqueInboundHandle<Runtime>,
    name: String,
    unit: String,
    description: String,
) -> BridgeResult<OpaqueOutboundHandle<HistogramF64>> {
    let core_runtime = runtime.borrow()?.core_runtime.clone();
    let meter = core_runtime
        .telemetry()
        .get_metric_meter()
        .ok_or(BridgeError::UnexpectedError(
            "Failed to get metric meter".into(),
        ))?;

    let histogram = meter.inner.histogram_f64(
        MetricParametersBuilder::default()
            .name(name)
            .unit(unit)
            .description(description)
            .build()
            .context("Failed to build metric parameters")?,
    );

    Ok(OpaqueOutboundHandle::new(HistogramF64 { meter, histogram }))
}

#[js_function]
pub fn new_metric_gauge(
    runtime: OpaqueInboundHandle<Runtime>,
    name: String,
    unit: String,
    description: String,
) -> BridgeResult<OpaqueOutboundHandle<Gauge>> {
    let core_runtime = runtime.borrow()?.core_runtime.clone();
    let meter = core_runtime
        .telemetry()
        .get_metric_meter()
        .ok_or(BridgeError::UnexpectedError(
            "Failed to get metric meter".into(),
        ))?;

    let gauge = meter.inner.gauge(
        MetricParametersBuilder::default()
            .name(name)
            .unit(unit)
            .description(description)
            .build()
            .context("Failed to build metric parameters")?,
    );

    Ok(OpaqueOutboundHandle::new(Gauge { meter, gauge }))
}

#[js_function]
pub fn new_metric_gauge_f64(
    runtime: OpaqueInboundHandle<Runtime>,
    name: String,
    unit: String,
    description: String,
) -> BridgeResult<OpaqueOutboundHandle<GaugeF64>> {
    let core_runtime = runtime.borrow()?.core_runtime.clone();
    let meter = core_runtime
        .telemetry()
        .get_metric_meter()
        .ok_or(BridgeError::UnexpectedError(
            "Failed to get metric meter".into(),
        ))?;

    let gauge = meter.inner.gauge_f64(
        MetricParametersBuilder::default()
            .name(name)
            .unit(unit)
            .description(description)
            .build()
            .context("Failed to build metric parameters")?,
    );

    Ok(OpaqueOutboundHandle::new(GaugeF64 { meter, gauge }))
}

// We do not need to worry about losing the sign of `value` as JS verifies this is positive
// It is understood that if passing in a float to a counter the value will be truncated
#[js_function]
#[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
pub fn add_metric_counter_value(
    counter_handle: OpaqueInboundHandle<Counter>,
    value: f64,
    attributes: JsonString<MetricAttributes>,
) -> BridgeResult<()> {
    let counter_handle = counter_handle.borrow()?;

    let attributes = counter_handle
        .meter
        .inner
        .new_attributes(parse_metric_attributes(attributes.value));

    counter_handle.counter.add(value as u64, &attributes);
    Ok(())
}

#[js_function]
pub fn record_metric_histogram_value(
    histogram_handle: OpaqueInboundHandle<Histogram>,
    value: u64,
    attributes: JsonString<MetricAttributes>,
) -> BridgeResult<()> {
    let histogram_handle = histogram_handle.borrow()?;
    let attributes = histogram_handle
        .meter
        .inner
        .new_attributes(parse_metric_attributes(attributes.value));
    histogram_handle.histogram.record(value, &attributes);
    Ok(())
}

#[js_function]
pub fn record_metric_histogram_f64_value(
    histogram_handle: OpaqueInboundHandle<HistogramF64>,
    value: f64,
    attributes: JsonString<MetricAttributes>,
) -> BridgeResult<()> {
    let histogram_handle = histogram_handle.borrow()?;
    let attributes = histogram_handle
        .meter
        .inner
        .new_attributes(parse_metric_attributes(attributes.value));
    histogram_handle.histogram.record(value, &attributes);
    Ok(())
}

#[js_function]
pub fn set_metric_gauge_value(
    gauge_handle: OpaqueInboundHandle<Gauge>,
    value: u64,
    attributes: JsonString<MetricAttributes>,
) -> BridgeResult<()> {
    let gauge_handle = gauge_handle.borrow()?;
    let attributes = gauge_handle
        .meter
        .inner
        .new_attributes(parse_metric_attributes(attributes.value));
    gauge_handle.gauge.record(value, &attributes);
    Ok(())
}

#[js_function]
pub fn set_metric_gauge_f64_value(
    gauge_handle: OpaqueInboundHandle<GaugeF64>,
    value: f64,
    attributes: JsonString<MetricAttributes>,
) -> BridgeResult<()> {
    let gauge_handle = gauge_handle.borrow()?;
    let attributes = gauge_handle
        .meter
        .inner
        .new_attributes(parse_metric_attributes(attributes.value));
    gauge_handle.gauge.record(value, &attributes);
    Ok(())
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Buffered Metrics (aka lang-side metrics exporter)
////////////////////////////////////////////////////////////////////////////////////////////////////

#[derive(Debug)]
pub struct MetricsCallBuffer {
    pub(crate) core_buffer: Arc<CoreMetricsCallBuffer<BufferedMetricRef>>,
    use_seconds_for_durations: bool,
}

impl MetricsCallBuffer {
    pub(crate) fn new(max_buffer_size: usize, use_seconds_for_durations: bool) -> Self {
        Self {
            core_buffer: Arc::new(CoreMetricsCallBuffer::new(max_buffer_size)),
            use_seconds_for_durations,
        }
    }

    pub(crate) fn retrieve(&self) -> Vec<BufferedMetricUpdate> {
        self.core_buffer
            .retrieve()
            .iter()
            .filter_map(|e| self.convert_metric_event(e))
            .collect()
    }

    fn convert_metric_event(
        &self,
        event: &CoreMetricEvent<BufferedMetricRef>,
    ) -> Option<BufferedMetricUpdate> {
        match event {
            CoreMetricEvent::Create {
                params,
                populate_into,
                kind,
            } => {
                // Create the metric and put it on the lazy ref
                let metric = BufferedMetric::new(params, kind, self.use_seconds_for_durations);
                populate_into
                    .set(Arc::new(BufferedMetricRef(MemoizedHandle::new(metric))))
                    .expect("Unable to set buffered metric on reference");

                None
            }

            // Create the attributes and put it on the lazy ref
            CoreMetricEvent::CreateAttributes {
                populate_into,
                append_from,
                attributes,
            } => {
                let append_from = append_from.as_ref().map(|f| {
                    f.get()
                        .clone()
                        .as_any()
                        .downcast::<BufferedMetricAttributesRef>()
                        .expect("Unable to downcast to expected buffered metric attributes")
                });
                let attributes = BufferedMetricAttributes {
                    new_attributes: attributes.clone(),
                    append_from: append_from.map(|f| f.as_ref().clone()),
                };

                let r = BufferedMetricAttributesRef(MemoizedHandle::new(attributes));
                populate_into
                    .set(Arc::new(r))
                    .expect("Unable to set buffered metric attributes on reference");

                None
            }

            CoreMetricEvent::Update {
                instrument,
                attributes,
                update,
            } => Some(BufferedMetricUpdate {
                metric: instrument.get().as_ref().clone(),
                value: match update {
                    metrics::MetricUpdateVal::Duration(v) if self.use_seconds_for_durations => {
                        v.as_secs_f64()
                    }
                    metrics::MetricUpdateVal::Duration(v) => v.as_millis() as f64,
                    metrics::MetricUpdateVal::Delta(v) => *v as f64,
                    metrics::MetricUpdateVal::DeltaF64(v) => *v,
                    metrics::MetricUpdateVal::Value(v) => *v as f64,
                    metrics::MetricUpdateVal::ValueF64(v) => *v,
                },
                attributes: attributes
                    .get()
                    .clone()
                    .as_any()
                    .downcast::<BufferedMetricAttributesRef>()
                    .expect("Unable to downcast to expected buffered metric attributes")
                    .as_ref()
                    .clone(),
            }),
        }
    }
}

#[derive(TryIntoJs)]
pub struct BufferedMetricUpdate {
    metric: BufferedMetricRef,
    value: f64,
    attributes: BufferedMetricAttributesRef,
}

#[derive(TryIntoJs, Clone, Debug)]
struct BufferedMetric {
    name: String,
    description: OptionAsUndefined<String>,
    unit: OptionAsUndefined<String>,
    kind: MetricKind,
    value_type: MetricValueType,
}

impl BufferedMetric {
    pub fn new(
        params: &CoreMetricParameters,
        kind: &CoreMetricKind,
        use_seconds_for_durations: bool,
    ) -> Self {
        let unit = match *kind {
            CoreMetricKind::HistogramDuration if params.unit == "duration" => {
                Some((if use_seconds_for_durations { "s" } else { "ms" }).to_string())
            }
            _ => (!params.unit.is_empty()).then_some(params.unit.to_string()),
        };

        let (kind, value_type) = match *kind {
            CoreMetricKind::Counter => (MetricKind::Counter, MetricValueType::Int),
            CoreMetricKind::Gauge => (MetricKind::Gauge, MetricValueType::Int),
            CoreMetricKind::GaugeF64 => (MetricKind::Gauge, MetricValueType::Float),
            CoreMetricKind::Histogram => (MetricKind::Histogram, MetricValueType::Int),
            CoreMetricKind::HistogramF64 => (MetricKind::Histogram, MetricValueType::Float),
            CoreMetricKind::HistogramDuration => (MetricKind::Histogram, MetricValueType::Int),
        };

        let description =
            (!params.description.is_empty()).then_some(params.description.to_string());

        Self {
            name: params.name.to_string(),
            description: description.into(),
            unit: unit.into(),
            kind,
            value_type,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BufferedMetricRef(MemoizedHandle<BufferedMetric>);
impl CoreBufferInstrumentRef for BufferedMetricRef {}

impl TryIntoJs for BufferedMetricRef {
    type Output = JsObject;
    fn try_into_js<'cx>(self, cx: &mut impl Context<'cx>) -> JsResult<'cx, Self::Output> {
        self.0.try_into_js(cx)
    }
}

#[derive(Clone, Debug)]
struct BufferedMetricAttributes {
    new_attributes: Vec<CoreMetricKeyValue>,
    append_from: Option<BufferedMetricAttributesRef>,
}

impl TryIntoJs for BufferedMetricAttributes {
    type Output = JsObject;
    fn try_into_js<'cx>(self, cx: &mut impl Context<'cx>) -> JsResult<'cx, Self::Output> {
        let object = cx.empty_object();

        // Copy existing attributes, if any
        if let Some(existing) = self.append_from {
            let existing_attrs = existing.try_into_js(cx)?;

            object_assign(cx, object, existing_attrs)?;
        }

        // Assign new attributes
        for kv in self.new_attributes {
            let k = kv.key.as_str();
            match &kv.value {
                metrics::MetricValue::String(v) => object.set_property_from(cx, k, v.as_str()),
                metrics::MetricValue::Int(v) => object.set_property_from(cx, k, *v as f64),
                metrics::MetricValue::Float(v) => object.set_property_from(cx, k, *v),
                metrics::MetricValue::Bool(v) => object.set_property_from(cx, k, *v),
            }?;
        }

        Ok(object)
    }
}

#[derive(Clone, Debug)]
struct BufferedMetricAttributesRef(MemoizedHandle<BufferedMetricAttributes>);

impl CustomMetricAttributes for BufferedMetricAttributesRef {
    fn as_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self as Arc<dyn Any + Send + Sync>
    }
}

impl TryIntoJs for BufferedMetricAttributesRef {
    type Output = JsObject;
    fn try_into_js<'cx>(self, cx: &mut impl Context<'cx>) -> JsResult<'cx, Self::Output> {
        self.0.try_into_js(cx)
    }
}

#[derive(TryIntoJs, Clone, Debug)]
enum MetricKind {
    Counter,
    Gauge,
    Histogram,
}

#[derive(TryIntoJs, Clone, Debug)]
enum MetricValueType {
    Int,
    Float,
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Helpers
////////////////////////////////////////////////////////////////////////////////////////////////////

fn parse_metric_attributes(attrs: MetricAttributes) -> NewAttributes {
    let attrs = attrs
        .attributes
        .into_iter()
        .map(|(key, value)| CoreMetricKeyValue {
            key,
            value: value.into(),
        })
        .collect();
    NewAttributes { attributes: attrs }
}

fn object_assign<'cx>(
    cx: &mut impl Context<'cx>,
    object: Handle<'cx, JsObject>,
    source: Handle<'cx, JsObject>,
) -> JsResult<'cx, JsObject> {
    let object_class = cx.global::<JsFunction>("Object")?;
    let assign_function = object_class.get::<JsFunction, _, _>(cx, "assign")?;
    let null = cx.null();
    assign_function.call(cx, null, vec![object.upcast(), source.upcast()])?;

    Ok(object)
}
