import type {
  MetricCounter,
  MetricGauge,
  MetricHistogram,
  MetricMeter,
  MetricTags,
  MetricUpDownCounter,
  NumericMetricValueType,
} from '@temporalio/common';
import { MetricMeterWithComposedTags } from '@temporalio/common';
import { composeInterceptors } from './interceptor-composition';
import type { Sink, Sinks } from './sinks';
import { proxySinks } from './sinks';
import { workflowInfo } from './workflow';
import { assertInWorkflowContext } from './global-attributes';
import type { Activator } from './internals';

function stableTagsKey(tags: MetricTags): string {
  const keys = Object.keys(tags).sort();
  if (keys.length === 0) return '';
  return JSON.stringify(keys.map((k) => [k, tags[k]]));
}

function metricDescriptorKey(name: string, unit: string | undefined, description: string | undefined): string {
  return JSON.stringify([name, unit ?? null, description ?? null]);
}

// Per-workflow cache keyed by Activator. Each workflow execution gets its
// own singleton instances per metric descriptor. Required so that `add` calls
// against `metricMeter.createUpDownCounter('foo')` from multiple call
// sites accumulate against one canonical net-value map.
const upDownCounterCaches = new WeakMap<Activator, Map<string, WorkflowMetricUpDownCounter>>();

function getOrCreateUpDownCounter(
  activator: Activator,
  name: string,
  unit: string | undefined,
  description: string | undefined
): WorkflowMetricUpDownCounter {
  let cache = upDownCounterCaches.get(activator);
  if (cache === undefined) {
    cache = new Map();
    upDownCounterCaches.set(activator, cache);
  }
  const key = metricDescriptorKey(name, unit, description);
  let counter = cache.get(key);
  if (counter === undefined) {
    counter = new WorkflowMetricUpDownCounter(name, unit, description);
    cache.set(key, counter);
  }
  return counter;
}

class WorkflowMetricMeterImpl implements MetricMeter {
  constructor() {}

  createCounter(name: string, unit?: string, description?: string): MetricCounter {
    assertInWorkflowContext("Workflow's `metricMeter` can only be used while in Workflow Context");
    return new WorkflowMetricCounter(name, unit, description);
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

  createUpDownCounter(name: string, unit?: string, description?: string): MetricUpDownCounter {
    const activator = assertInWorkflowContext("Workflow's `metricMeter` can only be used while in Workflow Context");
    return getOrCreateUpDownCounter(activator, name, unit, description);
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

class WorkflowMetricUpDownCounter implements MetricUpDownCounter {
  public readonly kind = 'up-down-counter';
  public readonly valueType = 'int';

  // Cumulative net value per stable tag-key. Replay rebuilds this map by
  // re-executing the workflow, so on a fresh sandbox the values match what
  // they were on the previous worker — emitting the same absolute net.
  private readonly netValues = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly unit: string | undefined,
    public readonly description: string | undefined
  ) {}

  add(value: number, tags?: MetricTags): void {
    const resolvedTags = tags ?? {};
    const key = stableTagsKey(resolvedTags);
    const newNet = (this.netValues.get(key) ?? 0) + value;
    this.netValues.set(key, newNet);
    // Always emit — including during replay. The worker sink applies only
    // the delta from the previously tracked net, so idempotent replays
    // produce delta=0 and no native call.
    metricSink.addMetricUpDownCounterValue(this.name, this.unit, this.description, newNet, resolvedTags);
  }

  withTags(_tags: MetricTags): MetricUpDownCounter {
    throw new Error('withTags is not supported directly on WorkflowMetricUpDownCounter');
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

// Note: given that forwarding metrics outside of the sanbox can be quite chatty and add non
// negligeable overhead, we eagerly check for `isReplaying` and completely skip doing sink
// calls if we are replaying.
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

  addMetricUpDownCounterValue(
    metricName: string,
    unit: string | undefined,
    description: string | undefined,
    netValue: number,
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
