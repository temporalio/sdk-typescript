import {
  MetricCounter,
  MetricGauge,
  MetricHistogram,
  MetricMeter,
  MetricMeterWithComposedTags,
  MetricTags,
  MetricUpDownCounter,
  NumericMetricValueType,
} from '@temporalio/common';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { proxySinks, Sink, Sinks } from './sinks';
import { workflowInfo } from './workflow';
import { assertInWorkflowContext } from './global-attributes';
import type { Activator } from './internals';

/**
 * Per-workflow cache of UpDownCounter instances, keyed by metric name.
 * Uses a WeakMap on the Activator so that each workflow execution gets
 * its own set of singletons, even in reuseV8Context mode.
 */
const upDownCounterCaches = new WeakMap<Activator, Map<string, WorkflowMetricUpDownCounter>>();

function getOrCreateUpDownCounter(
  activator: Activator,
  name: string,
  unit: string | undefined,
  description: string | undefined
): WorkflowMetricUpDownCounter {
  let cache = upDownCounterCaches.get(activator);
  if (!cache) {
    cache = new Map();
    upDownCounterCaches.set(activator, cache);
  }
  let counter = cache.get(name);
  if (!counter) {
    counter = new WorkflowMetricUpDownCounter(name, unit, description);
    cache.set(name, counter);
  }
  return counter;
}

class WorkflowMetricMeterImpl implements MetricMeter {
  constructor() {}

  createCounter(name: string, unit?: string, description?: string): MetricCounter {
    assertInWorkflowContext("Workflow's `metricMeter` can only be used while in Workflow Context");
    return new WorkflowMetricCounter(name, unit, description);
  }

  createUpDownCounter(name: string, unit?: string, description?: string): MetricUpDownCounter {
    const activator = assertInWorkflowContext("Workflow's `metricMeter` can only be used while in Workflow Context");
    return getOrCreateUpDownCounter(activator, name, unit, description);
  }

  createHistogram(
    name: string,
    valueType: NumericMetricValueType = 'int',
    unit?: string,
    description?: string
  ): MetricHistogram {
    assertInWorkflowContext("Workflow's `metricMeter` can only be used while in Workflow Context");
    return new WorkflowMetricHistogram(name, valueType, unit, description);
  }

  createGauge(
    name: string,
    valueType: NumericMetricValueType = 'int',
    unit?: string,
    description?: string
  ): MetricGauge {
    assertInWorkflowContext("Workflow's `metricMeter` can only be used while in Workflow Context");
    return new WorkflowMetricGauge(name, valueType, unit, description);
  }

  withTags(_tags: MetricTags): MetricMeter {
    assertInWorkflowContext("Workflow's `metricMeter` can only be used while in Workflow Context");
    // Tags composition is handled by a MetricMeterWithComposedTags wrapper over this one
    throw new Error(`withTags is not supported directly on WorkflowMetricMeter`);
  }
}

class WorkflowMetricCounter implements MetricCounter {
  public readonly kind = 'counter';
  public readonly valueType = 'int';

  constructor(
    public readonly name: string,
    public readonly unit: string | undefined,
    public readonly description: string | undefined
  ) {}

  add(value: number, extraTags: MetricTags = {}): void {
    if (value < 0) {
      throw new Error(`MetricCounter value must be non-negative (got ${value})`);
    }
    if (!workflowInfo().unsafe.isReplaying) {
      metricSink.addMetricCounterValue(this.name, this.unit, this.description, value, extraTags);
    }
  }

  withTags(_tags: MetricTags): MetricCounter {
    // Tags composition is handled by a MetricMeterWithComposedTags wrapper over this one
    throw new Error(`withTags is not supported directly on WorkflowMetricCounter`);
  }
}

/**
 * Replay-safe UpDownCounter for workflow metrics.
 *
 * Unlike other metric types which skip emission during replay, the UpDownCounter
 * tracks its cumulative net value per tag combination and always emits the absolute
 * net value to the worker sink. This allows the sink to correctly reconstruct the
 * metric state after cache eviction (same process) or worker restart (new process).
 *
 * Singleton per metric name per workflow execution — enforced by the WeakMap cache
 * on the Activator. This follows OpenTelemetry conventions where the same instrument
 * name always returns the same instrument.
 */
class WorkflowMetricUpDownCounter implements MetricUpDownCounter {
  public readonly kind = 'up_down_counter';
  public readonly valueType = 'int';

  /**
   * Tracks the cumulative net value per tag combination.
   * Key is a stable serialization of the tags object.
   */
  private readonly netValues = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly unit: string | undefined,
    public readonly description: string | undefined
  ) {}

  add(value: number, tags?: MetricTags): void {
    const resolvedTags = tags ?? {};
    const key = stableTagsKey(resolvedTags);
    const oldNet = this.netValues.get(key) ?? 0;
    const newNet = oldNet + value;
    this.netValues.set(key, newNet);

    // Always emit — even during replay. The sink receives the absolute net value
    // and applies only the delta from what it previously tracked for this workflow.
    // This makes UpDownCounter correct across cache evictions and worker restarts.
    metricSink.addMetricUpDownCounterValue(this.name, this.unit, this.description, newNet, resolvedTags);
  }

  withTags(_tags: MetricTags): MetricUpDownCounter {
    // Tags composition is handled by a MetricMeterWithComposedTags wrapper over this one
    throw new Error('withTags is not supported directly on WorkflowMetricUpDownCounter');
  }
}

class WorkflowMetricHistogram implements MetricHistogram {
  public readonly kind = 'histogram';

  constructor(
    public readonly name: string,
    public readonly valueType: NumericMetricValueType,
    public readonly unit: string | undefined,
    public readonly description: string | undefined
  ) {}

  record(value: number, extraTags: MetricTags = {}): void {
    if (value < 0) {
      throw new Error(`MetricHistogram value must be non-negative (got ${value})`);
    }
    if (!workflowInfo().unsafe.isReplaying) {
      metricSink.recordMetricHistogramValue(this.name, this.valueType, this.unit, this.description, value, extraTags);
    }
  }

  withTags(_tags: MetricTags): MetricHistogram {
    // Tags composition is handled by a MetricMeterWithComposedTags wrapper over this one
    throw new Error(`withTags is not supported directly on WorkflowMetricHistogram`);
  }
}

class WorkflowMetricGauge implements MetricGauge {
  public readonly kind = 'gauge';

  constructor(
    public readonly name: string,
    public readonly valueType: NumericMetricValueType,
    public readonly unit: string | undefined,
    public readonly description: string | undefined
  ) {}

  set(value: number, tags?: MetricTags): void {
    if (value < 0) {
      throw new Error(`MetricGauge value must be non-negative (got ${value})`);
    }
    if (!workflowInfo().unsafe.isReplaying) {
      metricSink.setMetricGaugeValue(this.name, this.valueType, this.unit, this.description, value, tags ?? {});
    }
  }

  withTags(_tags: MetricTags): MetricGauge {
    // Tags composition is handled by a MetricMeterWithComposedTags wrapper over this one
    throw new Error(`withTags is not supported directly on WorkflowMetricGauge`);
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Serializes tags into a stable string key for the per-instance net value tracking.
 * Keys are sorted to ensure deterministic ordering regardless of insertion order.
 */
function stableTagsKey(tags: MetricTags): string {
  const keys = Object.keys(tags).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${tags[k]}`).join(',');
}

// Note: given that forwarding metrics outside of the sanbox can be quite chatty and add non
// negligeable overhead, we eagerly check for `isReplaying` and completely skip doing sink
// calls if we are replaying. The exception is UpDownCounter, which must emit during replay
// to correctly rebuild its state after cache eviction or worker restart.
const metricSink = proxySinks<MetricSinks>().__temporal_metrics;

/**
 * Sink interface for forwarding metrics from the Workflow sandbox to the Worker.
 *
 * These sink functions are not intended to be called directly from workflow code; instead,
 * developers should use the `metricMeter` object exposed to workflow code by the SDK, which
 * provides an API that is easier to work with.
 *
 * This sink interface is also not meant to be implemented by user.
 *
 * @hidden
 * @internal Users should not implement this interface, nor use it directly. Use `metricMeter` instead.
 */
export interface MetricSinks extends Sinks {
  __temporal_metrics: WorkflowMetricMeter;
}

/**
 * @hidden
 * @internal Users should not implement this interface, nor use it directly. Use `metricMeter` instead.
 */
export interface WorkflowMetricMeter extends Sink {
  addMetricCounterValue(
    metricName: string,
    unit: string | undefined,
    description: string | undefined,
    value: number,
    attrs: MetricTags
  ): void;

  /**
   * Receives the absolute net value of an UpDownCounter for a workflow, not a delta.
   * The worker sink tracks per-workflow contributions and applies only the real delta
   * to the underlying metric, enabling correct behavior across replays.
   */
  addMetricUpDownCounterValue(
    metricName: string,
    unit: string | undefined,
    description: string | undefined,
    netValue: number,
    attrs: MetricTags
  ): void;

  recordMetricHistogramValue(
    metricName: string,
    valueType: NumericMetricValueType,
    unit: string | undefined,
    description: string | undefined,
    value: number,
    attrs: MetricTags
  ): void;

  setMetricGaugeValue(
    metricName: string,
    valueType: NumericMetricValueType,
    unit: string | undefined,
    description: string | undefined,
    value: number,
    attrs: MetricTags
  ): void;
}

/**
 * A MetricMeter that can be used to emit metrics from within a Workflow.
 *
 * @experimental The Metric API is an experimental feature and may be subject to change.
 */
export const metricMeter: MetricMeter = MetricMeterWithComposedTags.compose(
  new WorkflowMetricMeterImpl(),
  () => {
    const activator = assertInWorkflowContext('Workflow.metricMeter may only be used from workflow context.');
    const getMetricTags = composeInterceptors(activator.interceptors.outbound, 'getMetricTags', (a) => a);

    const info = activator.info;
    return getMetricTags({
      // namespace and taskQueue will be added by the Worker
      workflowType: info.workflowType,
    });
  },
  true
);
