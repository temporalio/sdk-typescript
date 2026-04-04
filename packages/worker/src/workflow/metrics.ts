import {
  NumericMetricValueType,
  type MetricMeter,
  type MetricTags,
  type MetricUpDownCounter,
  Metric,
} from '@temporalio/common';
import type { WorkflowInfo } from '@temporalio/workflow';
import { MetricSinks } from '@temporalio/workflow/lib/metrics';
import { InjectedSinks } from '../sinks';

/**
 * Serializes metric tags into a stable string key for use in tracking maps.
 * Keys are sorted to ensure deterministic ordering.
 */
function tagsKey(tags: MetricTags): string {
  const keys = Object.keys(tags).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${tags[k]}`).join(',');
}

/**
 * Tracks per-workflow UpDownCounter contributions so that the actual metric
 * only reflects workflows currently cached on this worker.
 *
 * When a workflow replays (due to cache eviction or worker restart), the
 * workflow sandbox rebuilds its net UpDownCounter values from scratch and
 * emits the absolute net value to the sink. The sink computes the delta
 * from what it previously tracked for that workflow and applies only the
 * difference to the real metric. On eviction, all tracked contributions
 * for that workflow are undone.
 */
interface TrackedContribution {
  metricName: string;
  unit: string | undefined;
  description: string | undefined;
  tags: MetricTags;
  netValue: number;
}

export interface MetricSinkWithCleanup {
  sinks: InjectedSinks<MetricSinks>;
  /**
   * Undo all UpDownCounter contributions for a workflow that is being
   * evicted from the cache. This ensures the process-level metric
   * only reflects workflows that are currently active on this worker.
   */
  cleanupWorkflow(runId: string): void;
}

export function initMetricSink(metricMeter: MetricMeter): MetricSinkWithCleanup {
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

  // Per-workflow UpDownCounter tracking.
  // Key: `${runId}\0${metricName}\0${tagsKey}` → TrackedContribution
  const perWorkflowUpDownCounters = new Map<string, TrackedContribution>();

  function getUpDownCounter(metricName: string, unit: string | undefined, description: string | undefined): MetricUpDownCounter {
    const cacheKey = `${metricName}:up_down_counter`;
    return getOrCreate(cacheKey, () => metricMeter.createUpDownCounter(metricName, unit, description));
  }

  function trackingKey(runId: string, metricName: string, tags: MetricTags): string {
    return `${runId}\0${metricName}\0${tagsKey(tags)}`;
  }

  return {
    sinks: {
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
        addMetricUpDownCounterValue: {
          fn(
            workflowInfo: WorkflowInfo,
            metricName: string,
            unit: string | undefined,
            description: string | undefined,
            netValue: number,
            attrs: MetricTags
          ) {
            const runId = workflowInfo.runId;
            const key = trackingKey(runId, metricName, attrs);
            const existing = perWorkflowUpDownCounters.get(key);
            const oldNetValue = existing?.netValue ?? 0;
            const delta = netValue - oldNetValue;

            perWorkflowUpDownCounters.set(key, {
              metricName,
              unit,
              description,
              tags: attrs,
              netValue,
            });

            if (delta !== 0) {
              getUpDownCounter(metricName, unit, description).add(delta, attrs);
            }
          },
          // Must be called during replay so that UpDownCounter state is rebuilt
          // correctly after cache eviction or worker restart.
          callDuringReplay: true,
        },
      },
    },
    cleanupWorkflow(runId: string): void {
      const prefix = `${runId}\0`;
      for (const [key, contribution] of perWorkflowUpDownCounters) {
        if (key.startsWith(prefix)) {
          if (contribution.netValue !== 0) {
            getUpDownCounter(contribution.metricName, contribution.unit, contribution.description).add(
              -contribution.netValue,
              contribution.tags
            );
          }
          perWorkflowUpDownCounters.delete(key);
        }
      }
    },
  };
}
