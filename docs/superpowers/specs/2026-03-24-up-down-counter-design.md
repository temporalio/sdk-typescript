# UpDownCounter Metric Type

## Summary

Add an `UpDownCounter` metric instrument to both the Temporal Rust Core SDK (`sdk-core`) and the TypeScript SDK (`sdk-typescript`). This enables tracking inflight/active counts (e.g. active workflows, in-progress activities) using the standard OTel `UpDownCounter` primitive, which maps to a Prometheus gauge and a Datadog gauge.

Currently the SDK only exposes `Counter` (monotonic, `u64`), `Histogram`, and `Gauge` (set-only). There is no way to express additive positive/negative deltas — the standard pattern for inflight counting.

## Design Decisions

- **Integer only (`i64`)** — No `f64` variant. Inflight counting is inherently integral, and this matches how `Counter` was implemented (integer only). Float can be added later if needed.
- **No in-memory heartbeat variant** — The `_with_in_memory` pattern used by `Gauge` and `Counter` in the core SDK is only for internal worker metrics. Not needed for UpDownCounter.
- **Signed value at the bridge layer** — A new `temporal_core_metric_record_integer_signed` FFI function is needed because the existing `record_integer` takes `u64`.

## Rust Core SDK Changes

### `crates/common/src/telemetry/metrics.rs`

- New `UpDownCounterBase` trait: `fn adds(&self, value: i64)`
- New `UpDownCounter` struct wrapping `LazyBoundMetric`, with `fn add(&self, value: i64, attributes: &MetricAttributes)`
- `impl UpDownCounterBase for UpDownCounter`
- `impl MetricAttributable<UpDownCounter> for UpDownCounter`
- Add `fn up_down_counter(&self, params: MetricParameters) -> UpDownCounter` to `CoreMeter` trait
- Add no-op impl in `NoOpCoreMeter`
- Add `impl_no_op!(UpDownCounterBase, i64)` or equivalent

### `crates/common/src/telemetry/otel.rs`

- Implement `fn up_down_counter()` using `self.meter.i64_up_down_counter(params.name)`
- Add `UpDownCounterBase` impl for `InstrumentWithAttributes<metrics::UpDownCounter<i64>>` calling `self.inner.add(value, kvs)`
- Add `MetricAttributable<Box<dyn UpDownCounterBase>>` impl for `metrics::UpDownCounter<i64>`

### `crates/common/src/telemetry/prometheus_meter.rs`

- Use `IntGaugeVec` (same underlying Prometheus type as integer gauge — Prometheus has no distinct up-down-counter)
- Add `UpDownCounterBase` impl for `CorePromIntGauge` calling `self.0.add(value)`
- Add `MetricAttributable<Box<dyn UpDownCounterBase>>` impl for `PromMetric<IntGaugeVec>`

### `crates/sdk-core-c-bridge/src/metric.rs`

- Add `UpDownCounterInteger` to `MetricKind` C enum
- Add `UpDownCounterInteger(metrics::UpDownCounter)` to `Metric` enum
- Handle in `temporal_core_metric_new`
- New FFI function `temporal_core_metric_record_integer_signed(metric, value: i64, attrs)` — matches on `UpDownCounterInteger` and calls `.add(value, &attrs.core)`
- Add `UpDownCounterBase` and `MetricAttributable` impls for `CustomMetric`

## TypeScript SDK Changes

### `packages/common/src/metrics.ts`

- Add `'up_down_counter'` to `MetricKind` type
- New `MetricUpDownCounter` interface extending `Metric`:
  - `add(value: number, extraTags?: MetricTags): void` — no non-negative check
  - `withTags(tags: MetricTags): MetricUpDownCounter`
  - `kind: 'up_down_counter'`
  - `valueType: 'int'`
- Add `createUpDownCounter(name, unit?, description?): MetricUpDownCounter` to `MetricMeter`
- Add noop impl in `NoopMetricMeter`
- Add `MetricUpDownCounterWithComposedTags` class
- Add `createUpDownCounter()` to `MetricMeterWithComposedTags`

### `packages/core-bridge/ts/native.ts`

- Add `MetricUpDownCounter` opaque type
- Add `newMetricUpDownCounter(runtime, name, unit, description)` declaration
- Add `addMetricUpDownCounterValue(counter, value: number, attrs)` declaration

### `packages/worker/src/runtime-metrics.ts`

- Add `RuntimeMetricUpDownCounter` class (follows `RuntimeMetricCounter` pattern, no `value < 0` check)
- Add `createUpDownCounter()` to `RuntimeMetricMeter`

### `packages/workflow/src/metrics.ts`

- Add `addMetricUpDownCounterValue` to `WorkflowMetricMeter` sink interface
- Add `WorkflowMetricUpDownCounter` class — replay-safe: always emits absolute net value to sink (no `isReplaying` guard), tracks cumulative net value per tag combination
- Singleton enforcement per metric name per workflow execution via `WeakMap<Activator>`
- Add `createUpDownCounter()` to `WorkflowMetricMeterImpl`

### `packages/worker/src/workflow/metrics.ts`

- Add `addMetricUpDownCounterValue` sink handler in `initMetricSink`
- Cache key: `${metricName}:up_down_counter`
- `callDuringReplay: true` — receives absolute net values from sandbox, tracks per-workflow contributions, applies only deltas to the real metric
- Exposes `cleanupWorkflow(runId)` to undo contributions on eviction
- `initMetricSink` returns `MetricSinkWithCleanup` (sinks + cleanup function)

### `packages/worker/src/worker.ts`

- Calls `cleanupWorkflowMetrics(runId)` on both eviction paths (eviction-only and eviction-with-jobs)

## Tests

### Rust — `crates/sdk-core/tests/integ_tests/metrics_tests.rs`

- Add UpDownCounter to the Prometheus metrics export test: create, add positive and negative values, assert scraped output shows expected value.

### TypeScript — `packages/test/src/test-metrics-custom.ts`

- Bridge-level test (no tags): `createUpDownCounter('my-up-down-counter')`, `.add(1)`, `.add(1)`, `.add(-1)`, assert Prometheus shows `1`
- Tags composition test: same pattern with labels
- Workflow test (`metricWorksWorkflow`): create, add positive/negative, verify across replay boundary
- Workflow tags test (`MetricTagsWorkflow`): verify `withTags` composition
- Interceptor test: verify interceptor tags are applied

### TypeScript — `packages/test/src/test-runtime-buffered-metrics.ts`

- Add UpDownCounter events: verify `kind: 'up_down_counter'`, `valueType: 'int'`, positive and negative values come through correctly.

## OTel/Prometheus/Datadog Mapping

| Temporal SDK | OTel Instrument | Prometheus Type | Datadog Type |
|---|---|---|---|
| Counter | Counter (u64) | counter | count |
| Histogram | Histogram | histogram | distribution |
| Gauge | Gauge (set-only) | gauge | gauge |
| **UpDownCounter (new)** | **UpDownCounter (i64)** | **gauge** | **gauge** |
