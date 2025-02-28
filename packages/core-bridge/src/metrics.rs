use crate::runtime::*;
use neon::{context::Context, prelude::*};
use serde::Deserialize;
use std::{cell::RefCell, collections::HashMap, sync::Arc};
use temporal_sdk_core::api::telemetry::metrics::{
    CoreMeter, Counter, Gauge, Histogram, MetricParametersBuilder, NewAttributes, TemporalMeter,
};
use temporal_sdk_core::api::telemetry::metrics::{GaugeF64, HistogramF64};
use temporal_sdk_core::api::telemetry::metrics::{
    MetricKeyValue as CoreMetricKeyValue, MetricValue as CoreMetricValue,
};

pub fn init(cx: &mut FunctionContext) -> NeonResult<()> {
    cx.export_function("newMetricCounter", new_metric_counter)?;
    cx.export_function("newMetricHistogram", new_metric_histogram)?;
    cx.export_function("newMetricGauge", new_metric_gauge)?;
    cx.export_function("addMetricCounterValue", add_metric_counter_value)?;
    cx.export_function("recordMetricHistogramValue", record_metric_histogram_value)?;
    cx.export_function("setMetricGaugeValue", set_metric_gauge_value)?;

    Ok(())
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

#[derive(Debug, Deserialize)]
pub struct MetricAttributes {
    #[serde(flatten)]
    pub attributes: HashMap<String, MetricValue>,
}

pub fn parse_metric_attributes(
    cx: &mut FunctionContext,
    attrs: String,
) -> NeonResult<NewAttributes> {
    // FIXME: Consider using a serde visitor instead of JSON -> HashMap -> iterating on KV -> NewAttributes
    let attrs = serde_json::from_str::<MetricAttributes>(&attrs).map_err(|e| {
        cx.throw_type_error::<_, MetricAttributes>(format!("Invalid metric attributes. {:?}", e))
            .unwrap_err()
    })?;

    let attrs = attrs
        .attributes
        .into_iter()
        .map(|(key, value)| CoreMetricKeyValue {
            key,
            value: value.into(),
        })
        .collect();

    Ok(NewAttributes { attributes: attrs })
}

pub struct CounterHandle {
    pub(crate) meter: TemporalMeter,
    pub(crate) counter: Arc<dyn Counter>,
}
pub type BoxedCounterHandle = JsBox<RefCell<Option<CounterHandle>>>;
impl Finalize for CounterHandle {}

pub enum HistogramHandle {
    HistogramInt(TemporalMeter, Arc<dyn Histogram>),
    HistogramF64(TemporalMeter, Arc<dyn HistogramF64>),
}
pub type BoxedHistogramHandle = JsBox<RefCell<Option<HistogramHandle>>>;
impl Finalize for HistogramHandle {}

pub enum GaugeHandle {
    GaugeInt(TemporalMeter, Arc<dyn Gauge>),
    GaugeF64(TemporalMeter, Arc<dyn GaugeF64>),
}
pub type BoxedGaugeHandle = JsBox<RefCell<Option<GaugeHandle>>>;
impl Finalize for GaugeHandle {}

/// Create a new metric counter
pub fn new_metric_counter(mut cx: FunctionContext) -> JsResult<BoxedCounterHandle> {
    let runtime = cx.argument::<BoxedRuntime>(0)?;
    let unit = cx.argument::<JsString>(2)?.value(&mut cx);
    let description = cx.argument::<JsString>(3)?.value(&mut cx);

    let mut builder = MetricParametersBuilder::default();
    builder.name(cx.argument::<JsString>(1)?.value(&mut cx));
    builder.unit(unit);
    builder.description(description);

    let meter = runtime
        .core_runtime
        .telemetry()
        .get_metric_meter()
        .expect("Failed to get metric meter");

    let counter = meter.inner.counter(builder.build().unwrap());

    Ok(cx.boxed(RefCell::new(Some(CounterHandle { meter, counter }))))
}

pub fn new_metric_histogram(mut cx: FunctionContext) -> JsResult<BoxedHistogramHandle> {
    let runtime = cx.argument::<BoxedRuntime>(0)?;
    let name = cx.argument::<JsString>(1)?.value(&mut cx);
    let value_type = cx.argument::<JsString>(2)?.value(&mut cx);
    let unit = cx.argument::<JsString>(3)?.value(&mut cx);
    let description = cx.argument::<JsString>(4)?.value(&mut cx);

    let mut builder = MetricParametersBuilder::default();
    builder.name(name);
    builder.unit(unit);
    builder.description(description);

    let meter = runtime
        .core_runtime
        .telemetry()
        .get_metric_meter()
        .expect("Failed to get metric meter");

    let histogram_handle = match value_type.as_str() {
        "int" => HistogramHandle::HistogramInt(
            meter.clone(),
            meter.inner.histogram(builder.build().unwrap()),
        ),
        "float" => HistogramHandle::HistogramF64(
            meter.clone(),
            meter.inner.histogram_f64(builder.build().unwrap()),
        ),
        _ => panic!("Invalid value type"),
    };

    Ok(cx.boxed(RefCell::new(Some(histogram_handle))))
}

pub fn new_metric_gauge(mut cx: FunctionContext) -> JsResult<BoxedGaugeHandle> {
    let runtime = cx.argument::<BoxedRuntime>(0)?;
    let name = cx.argument::<JsString>(1)?.value(&mut cx);
    let value_type = cx.argument::<JsString>(2)?.value(&mut cx);
    let unit = cx.argument::<JsString>(3)?.value(&mut cx);
    let description = cx.argument::<JsString>(4)?.value(&mut cx);

    let mut builder = MetricParametersBuilder::default();
    builder.name(name);
    builder.unit(unit);
    builder.description(description);

    let meter = runtime
        .core_runtime
        .telemetry()
        .get_metric_meter()
        .expect("Failed to get metric meter");

    let gauge_handle = match value_type.as_str() {
        "int" => GaugeHandle::GaugeInt(meter.clone(), meter.inner.gauge(builder.build().unwrap())),
        "float" => GaugeHandle::GaugeF64(
            meter.clone(),
            meter.inner.gauge_f64(builder.build().unwrap()),
        ),
        _ => panic!("Invalid value type"),
    };

    Ok(cx.boxed(RefCell::new(Some(gauge_handle))))
}

pub fn add_metric_counter_value(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let counter_handle = cx.argument::<BoxedCounterHandle>(0)?;
    let value = cx.argument::<JsNumber>(1)?.value(&mut cx);
    let attributes = cx.argument::<JsString>(2)?.value(&mut cx);

    match counter_handle.borrow().as_ref() {
        Some(CounterHandle { meter, counter }) => {
            let attributes = parse_metric_attributes(&mut cx, attributes)?;
            let attributes = meter.inner.new_attributes(attributes);
            counter.add(value as u64, &attributes);
        }
        None => cx
            .throw_error::<_, _>("Counter handle is not initialized")
            .unwrap(),
    }

    Ok(cx.undefined())
}

pub fn record_metric_histogram_value(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let histogram_handle = cx.argument::<BoxedHistogramHandle>(0)?;
    let value = cx.argument::<JsNumber>(1)?.value(&mut cx);
    let attributes = cx.argument::<JsString>(2)?.value(&mut cx);

    match histogram_handle.borrow().as_ref() {
        Some(HistogramHandle::HistogramInt(meter, hist)) => {
            let attributes = parse_metric_attributes(&mut cx, attributes)?;
            let attributes = meter.inner.new_attributes(attributes);
            hist.record(value as u64, &attributes);
        }
        Some(HistogramHandle::HistogramF64(meter, hist)) => {
            let attributes = parse_metric_attributes(&mut cx, attributes)?;
            let attributes = meter.inner.new_attributes(attributes);
            hist.record(value, &attributes);
        }
        None => cx
            .throw_error::<_, _>("Histogram handle is not initialized")
            .unwrap(),
    };

    Ok(cx.undefined())
}

pub fn set_metric_gauge_value(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let gauge_handle = cx.argument::<BoxedGaugeHandle>(0)?;
    let value = cx.argument::<JsNumber>(1)?.value(&mut cx);
    let attributes = cx.argument::<JsString>(2)?.value(&mut cx);

    match gauge_handle.borrow().as_ref() {
        Some(GaugeHandle::GaugeInt(meter, gauge)) => {
            let attributes = parse_metric_attributes(&mut cx, attributes)?;
            let attributes = meter.inner.new_attributes(attributes);
            gauge.record(value as u64, &attributes);
        }
        Some(GaugeHandle::GaugeF64(meter, gauge)) => {
            let attributes = parse_metric_attributes(&mut cx, attributes)?;
            let attributes = meter.inner.new_attributes(attributes);
            gauge.record(value, &attributes);
        }
        None => cx
            .throw_error::<_, _>("Gauge handle is not initialized")
            .unwrap(),
    }

    Ok(cx.undefined())
}
