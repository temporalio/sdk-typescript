import {
  MetricCounter,
  MetricGauge,
  MetricHistogram,
  MetricMeter,
  MetricMeterWithComposedTags,
  MetricTags,
  NumericMetricValueType,
} from '@temporalio/common';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { proxySinks, Sink, Sinks } from './sinks';
import { workflowInfo } from './workflow';
import { assertInWorkflowContext } from './global-attributes';

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

  withTags(_tags: MetricTags): MetricMeter {
    assertInWorkflowContext("Workflow's `metricMeter` can only be used while in Workflow Context");
    // Tags composition is handled by a MetricMeterWithComposedTags wrapper over this one
    throw new Error(`withTags is not supported directly on WorkflowMetricMeter`);
  }
}

class WorkflowMetricCounter implements MetricCounter {
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
