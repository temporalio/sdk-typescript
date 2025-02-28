import { NumericMetricValueType, type MetricMeter, type MetricTags } from '@temporalio/common';
import { MetricSinks } from '@temporalio/workflow/lib/metrics';
import { InjectedSinks } from '../sinks';

export function initMetricSink(metricMeter: MetricMeter): InjectedSinks<MetricSinks> {
  return {
    __temporal_metrics: {
      addMetricCounterValue: {
        fn(
          _,
          metricName: string,
          unit: string | undefined,
          description: string | undefined,
          value: number,
          attrs: MetricTags
        ) {
          // FIXME: Consider keeping a cache of metrics to avoid recreating the same metric over and over
          metricMeter.createCounter(metricName, unit, description).add(value, attrs);
        },
      },
      recordMetricHistogramValue: {
        fn(
          _,
          metricName: string,
          valueType: NumericMetricValueType,
          unit: string | undefined,
          description: string | undefined,
          value: number,
          attrs: MetricTags
        ) {
          // FIXME: Consider keeping a cache of metrics to avoid recreating the same metric over and over
          metricMeter.createHistogram(metricName, valueType, unit, description).record(value, attrs);
        },
      },
      setMetricGaugeValue: {
        fn(
          _,
          metricName: string,
          valueType: NumericMetricValueType,
          unit: string | undefined,
          description: string | undefined,
          value: number,
          attrs: MetricTags
        ) {
          // FIXME: Consider keeping a cache of metrics to avoid recreating the same metric over and over
          metricMeter.createGauge(metricName, valueType, unit, description).set(value, attrs);
        },
      },
    },
  };
}
