use std::ops::Deref;
use std::{collections::HashMap, sync::Arc};

use anyhow::Context as _;
use neon::prelude::*;
use serde::Deserialize;

use temporal_sdk_core::api::telemetry::metrics::{
    CoreMeter, Counter as CoreCounter, Gauge as CoreGauge, Histogram as CoreHistogram,
    MetricParametersBuilder, NewAttributes, TemporalMeter,
};
use temporal_sdk_core::api::telemetry::metrics::{
    GaugeF64 as CoreGaugeF64, HistogramF64 as CoreHistogramF64,
};
use temporal_sdk_core::api::telemetry::metrics::{
    MetricKeyValue as CoreMetricKeyValue, MetricValue as CoreMetricValue,
};

use bridge_macros::js_function;

use crate::helpers::{
    BridgeError, BridgeResult, JsonString, MutableFinalize, OpaqueInboundHandle,
    OpaqueOutboundHandle,
};
use crate::runtime::*;

pub fn init(cx: &mut neon::prelude::ModuleContext) -> neon::prelude::NeonResult<()> {
    cx.export_function("newMetricCounter", new_metric_counter)?;
    cx.export_function("newMetricHistogram", new_metric_histogram)?;
    cx.export_function("newMetricGauge", new_metric_gauge)?;
    cx.export_function("addMetricCounterValue", add_metric_counter_value)?;
    cx.export_function("recordMetricHistogramValue", record_metric_histogram_value)?;
    cx.export_function("setMetricGaugeValue", set_metric_gauge_value)?;

    Ok(())
}

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
            MetricValue::Int(i) => CoreMetricValue::Int(i),
            MetricValue::Float(f) => CoreMetricValue::Float(f),
            MetricValue::Bool(b) => CoreMetricValue::Bool(b),
            MetricValue::String(s) => CoreMetricValue::String(s),
        }
    }
}

pub struct CounterHandle {
    pub(crate) meter: TemporalMeter,
    pub(crate) counter: Arc<dyn CoreCounter>,
}

impl MutableFinalize for CounterHandle {}

pub enum HistogramHandle {
    HistogramInt(TemporalMeter, Arc<dyn CoreHistogram>),
    HistogramF64(TemporalMeter, Arc<dyn CoreHistogramF64>),
}
impl MutableFinalize for HistogramHandle {}

pub enum GaugeHandle {
    GaugeInt(TemporalMeter, Arc<dyn CoreGauge>),
    GaugeF64(TemporalMeter, Arc<dyn CoreGaugeF64>),
}
impl MutableFinalize for GaugeHandle {}

/// Create a new metric counter
#[js_function]
pub fn new_metric_counter(
    runtime: OpaqueInboundHandle<Runtime>,
    name: String,
    unit: String,
    description: String,
) -> BridgeResult<OpaqueOutboundHandle<CounterHandle>> {
    let meter = runtime
        .borrow()?
        .core_runtime
        .telemetry()
        .get_metric_meter()
        // FIXME: Unexpected or something else?
        .ok_or(BridgeError::UnexpectedError(
            "Failed to get metric meter".into(),
        ))?;

    let params = MetricParametersBuilder::default()
        .name(name)
        .unit(unit)
        .description(description)
        .build()
        .context("Failed to build metric parameters")?;

    let counter = meter.inner.counter(params);

    Ok(OpaqueOutboundHandle::new({
        CounterHandle { meter, counter }
    }))
}

#[js_function]
pub fn new_metric_histogram(
    runtime: OpaqueInboundHandle<Runtime>,
    name: String,
    value_type: String,
    unit: String,
    description: String,
) -> BridgeResult<OpaqueOutboundHandle<HistogramHandle>> {
    let meter = runtime
        .borrow()?
        .core_runtime
        .telemetry()
        .get_metric_meter()
        // FIXME: Unexpected or something else?
        .ok_or(BridgeError::UnexpectedError(
            "Failed to get metric meter".into(),
        ))?;

    let params = MetricParametersBuilder::default()
        .name(name)
        .unit(unit)
        .description(description)
        .build()
        .context("Failed to build metric parameters")?;

    let histogram_handle = match value_type.as_str() {
        "int" => HistogramHandle::HistogramInt(meter.clone(), meter.inner.histogram(params)),
        "float" => HistogramHandle::HistogramF64(meter.clone(), meter.inner.histogram_f64(params)),
        _ => Err(BridgeError::InvalidVariant {
            enum_name: "HistogramValueType".into(),
            variant: value_type.into(),
        })?,
    };

    Ok(OpaqueOutboundHandle::new(histogram_handle))
}

#[js_function]
pub fn new_metric_gauge(
    runtime: OpaqueInboundHandle<Runtime>,
    name: String,
    value_type: String,
    unit: String,
    description: String,
) -> BridgeResult<OpaqueOutboundHandle<GaugeHandle>> {
    let meter = runtime
        .borrow()?
        .core_runtime
        .telemetry()
        .get_metric_meter()
        .ok_or(BridgeError::UnexpectedError(
            "Failed to get metric meter".into(),
        ))?;

    let params = MetricParametersBuilder::default()
        .name(name)
        .unit(unit)
        .description(description)
        .build()
        .context("Failed to build metric parameters")?;

    let gauge_handle = match value_type.as_str() {
        "int" => GaugeHandle::GaugeInt(meter.clone(), meter.inner.gauge(params)),
        "float" => GaugeHandle::GaugeF64(meter.clone(), meter.inner.gauge_f64(params)),
        _ => Err(BridgeError::InvalidVariant {
            enum_name: "GaugeValueType".into(),
            variant: value_type.into(),
        })?,
    };

    Ok(OpaqueOutboundHandle::new(gauge_handle))
}

#[js_function]
pub fn add_metric_counter_value(
    counter_handle: OpaqueInboundHandle<CounterHandle>,
    value: f64,
    attributes: JsonString<MetricAttributes>,
) -> BridgeResult<()> {
    let counter_handle = counter_handle.borrow()?;
    let attributes = parse_metric_attributes(attributes.value);
    let attributes = counter_handle.meter.inner.new_attributes(attributes);
    counter_handle.counter.add(value as u64, &attributes);

    Ok(())
}

#[js_function]
pub fn record_metric_histogram_value(
    histogram_handle: OpaqueInboundHandle<HistogramHandle>,
    value: f64, // FIXME: We're loosing precision here
    attributes: JsonString<MetricAttributes>,
) -> BridgeResult<()> {
    let histogram_handle = histogram_handle.borrow()?;
    let attributes = parse_metric_attributes(attributes.value);

    match histogram_handle.deref() {
        HistogramHandle::HistogramInt(meter, hist) => {
            let attributes = meter.inner.new_attributes(attributes);
            hist.record(value as u64, &attributes);
        }
        HistogramHandle::HistogramF64(meter, hist) => {
            let attributes = meter.inner.new_attributes(attributes);
            hist.record(value, &attributes);
        }
    };

    Ok(())
}

#[js_function]
pub fn set_metric_gauge_value(
    gauge_handle: OpaqueInboundHandle<GaugeHandle>,
    value: f64, // FIXME: We're loosing precision here
    attributes: JsonString<MetricAttributes>,
) -> BridgeResult<()> {
    let gauge_handle = gauge_handle.borrow()?;
    let attributes = parse_metric_attributes(attributes.value);

    match gauge_handle.deref() {
        GaugeHandle::GaugeInt(meter, gauge) => {
            let attributes = meter.inner.new_attributes(attributes);
            gauge.record(value as u64, &attributes);
        }
        GaugeHandle::GaugeF64(meter, gauge) => {
            let attributes = meter.inner.new_attributes(attributes);
            gauge.record(value, &attributes);
        }
    }

    Ok(())
}

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
