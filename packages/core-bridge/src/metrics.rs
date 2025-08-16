use std::collections::HashMap;

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
use crate::runtime::Runtime;

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

#[js_function]
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
