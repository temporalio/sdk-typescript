import { NumericMetricValueType, type MetricMeter, type MetricTags, Metric } from '@temporalio/common';
import { MetricSinks } from '@temporalio/workflow/lib/metrics';
import { InjectedSinks } from '../sinks';

export function initMetricSink(metricMeter: MetricMeter): InjectedSinks<MetricSinks> {
  // Creation of a new metric object isn't quite cheap, requiring a call down the bridge to the
  // actual Metric Meter. Unfortunately, the workflow sandbox execution model doesn't allow to
  // reuse metric objects from the caller side. We therefore maintain local caches of metric
  // objects to avoid creating a new one for every single metric value being emitted.
  const cache = new Map<string, WeakRef<Metric>>();

  function getOrCreate<T extends Metric>(key: string, create: () => T): T {
    let value = cache.get(key)?.deref();
    if (value === undefined) {
      value = create();
      cache.set(key, new WeakRef(value));
    }
    return value as T;
  }

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
          const cacheKey = `${metricName}:counter`;
          const createFn = () => metricMeter.createCounter(metricName, unit, description);
          getOrCreate(cacheKey, createFn).add(value, attrs);
        },
        callDuringReplay: false,
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
          const cacheKey = `histogram:${valueType}:${metricName}`;
          const createFn = () => metricMeter.createHistogram(metricName, valueType, unit, description);
          getOrCreate(cacheKey, createFn).record(value, attrs);
        },
        callDuringReplay: false,
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
          const cacheKey = `gauge:${valueType}:${metricName}`;
          const createFn = () => metricMeter.createGauge(metricName, valueType, unit, description);
          getOrCreate(cacheKey, createFn).set(value, attrs);
        },
        callDuringReplay: false,
      },
    },
  };
}
