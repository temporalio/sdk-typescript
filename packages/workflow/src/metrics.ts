import {
  MetricCounter,
  MetricGauge,
  MetricHistogram,
  MetricMeter,
  MetricTags,
  NumericMetricValueType,
} from '@temporalio/common';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { proxySinks, Sink, Sinks } from './sinks';
import { workflowInfo } from './workflow';
import { assertInWorkflowContext } from './global-attributes';

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
 * Sink interface for forwarding metrics from the Workflow sandbox to the Worker.
 *
 * These sink functions are not intended to be called directly from workflow code; instead,
 * developers should use the `metricsMeter` object exposed to workflow code by the SDK, which
 * provides an API that is easier to work with.
 *
 * This sink interface is also not meant to be implemented by user.
 */
export interface MetricSinks extends Sinks {
  __temporal_metrics: WorkflowMetricMeter;
}

// Note: given that forwarding metrics outside of the sanbox can be quite chatty and add non
// negligeable overhead, we eagerly check for `isReplaying` and completely skip doing sink
// calls if we are replaying.
const metricsSink = proxySinks<MetricSinks>().__temporal_metrics;

class WorkflowMetricCounter implements MetricCounter {
  constructor(
    public readonly name: string,
    public readonly unit: string | undefined,
    public readonly description: string | undefined
  ) {}

  add(value: number, extraTags?: MetricTags | undefined): void {
    if (!workflowInfo().unsafe.isReplaying) {
      metricsSink.addMetricCounterValue(this.name, this.unit, this.description, value, extraTags ?? {});
    }
  }

  withTags(extraTags: MetricTags): MetricCounter {
    // FIXME: Add support for tags
    return this;
  }
}

class WorkflowMetricHistogram implements MetricHistogram {
  constructor(
    public readonly name: string,
    public readonly valueType: NumericMetricValueType,
    public readonly unit: string | undefined,
    public readonly description: string | undefined
  ) {}

  record(value: number, extraTags?: MetricTags | undefined): void {
    if (!workflowInfo().unsafe.isReplaying) {
      metricsSink.recordMetricHistogramValue(
        this.name,
        this.valueType,
        this.unit,
        this.description,
        value,
        extraTags ?? {}
      );
    }
  }

  withTags(extraTags: MetricTags): MetricHistogram {
    // FIXME: Add support for tags
    return this;
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
    if (!workflowInfo().unsafe.isReplaying) {
      metricsSink.setMetricGaugeValue(this.name, this.valueType, this.unit, this.description, value, tags ?? {});
    }
  }

  withTags(extraTags: MetricTags): MetricGauge {
    // FIXME: Add support for tags
    return this;
  }
}

class WorkflowMetricMeterImpl implements MetricMeter {
  constructor() {}

  createCounter(name: string, unit?: string, description?: string): MetricCounter {
    return new WorkflowMetricCounter(name, unit, description);
  }

  createHistogram(
    name: string,
    valueType: NumericMetricValueType = 'int',
    unit?: string,
    description?: string
  ): MetricHistogram {
    return new WorkflowMetricHistogram(name, valueType, unit, description);
  }

  createGauge(
    name: string,
    valueType: NumericMetricValueType = 'int',
    unit?: string,
    description?: string
  ): MetricGauge {
    return new WorkflowMetricGauge(name, valueType, unit, description);
  }

  withTags(extraTags: MetricTags): MetricMeter {
    // FIXME: Add support for tags
    return this;
  }
}

export const metricsMeter: MetricMeter = new WorkflowMetricMeterImpl();
