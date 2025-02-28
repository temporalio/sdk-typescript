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
