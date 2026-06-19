import { type Metric, type MetricMeter, type MetricTags, type MetricUpDownCounter } from '@temporalio/common';
import type { MetricSinks } from '@temporalio/workflow/lib/metrics';
import type { InjectedSinks } from '../sinks';

interface TrackedContribution {
  runId: string;
  metricName: string;
  unit: string | undefined;
  description: string | undefined;
  tags: MetricTags;
  netValue: number;
}

export function stableTagsKey(tags: MetricTags): string {
  const keys = Object.keys(tags).sort();
  if (keys.length === 0) return '';
  return JSON.stringify(keys.map((k) => [k, tags[k]]));
}

function metricDescriptorKey(name: string, unit: string | undefined, description: string | undefined): string {
  return JSON.stringify([name, unit ?? null, description ?? null]);
}

export class WorkflowMetricsTracker {
  private readonly perWorkflowUpDownCounters = new Map<string, TrackedContribution>();
  private readonly upDownCounterCache = new Map<string, MetricUpDownCounter>();

  constructor(private readonly metricMeter: MetricMeter) {}

  getInjectedSinks(): InjectedSinks<MetricSinks> {
    // Per-instrument cache so we don't recreate instruments on every emit. Uses
    // WeakRef so unused instruments can be garbage-collected.
    const cache = new Map<string, WeakRef<Metric>>();
    const getOrCreate = <T extends Metric>(key: string, create: () => T): T => {
      let value = cache.get(key)?.deref();
      if (value === undefined) {
        value = create();
        cache.set(key, new WeakRef(value));
      }
      return value as T;
    };

    return {
      __temporal_metrics: {
        addMetricCounterValue: {
          fn: (_, metricName, unit, description, value, attrs) => {
            const key = `${metricName}:counter`;
            getOrCreate(key, () => this.metricMeter.createCounter(metricName, unit, description)).add(value, attrs);
          },
          callDuringReplay: false,
        },
        recordMetricHistogramValue: {
          fn: (_, metricName, valueType, unit, description, value, attrs) => {
            const key = `histogram:${valueType}:${metricName}`;
            getOrCreate(key, () => this.metricMeter.createHistogram(metricName, valueType, unit, description)).record(
              value,
              attrs
            );
          },
          callDuringReplay: false,
        },
        setMetricGaugeValue: {
          fn: (_, metricName, valueType, unit, description, value, attrs) => {
            const key = `gauge:${valueType}:${metricName}`;
            getOrCreate(key, () => this.metricMeter.createGauge(metricName, valueType, unit, description)).set(
              value,
              attrs
            );
          },
          callDuringReplay: false,
        },
        addMetricUpDownCounterValue: {
          fn: (workflowInfo, metricName, unit, description, netValue, attrs) => {
            const key = JSON.stringify([
              workflowInfo.runId,
              metricName,
              unit ?? null,
              description ?? null,
              stableTagsKey(attrs),
            ]);
            const existing = this.perWorkflowUpDownCounters.get(key);
            const oldNet = existing?.netValue ?? 0;
            const delta = netValue - oldNet;
            this.perWorkflowUpDownCounters.set(key, {
              runId: workflowInfo.runId,
              metricName,
              unit,
              description,
              tags: attrs,
              netValue,
            });
            if (delta !== 0) {
              this.getUpDownCounter(metricName, unit, description).add(delta, attrs);
            }
          },
          callDuringReplay: true,
        },
      },
    };
  }

  notifyWorkflowEvicted(runId: string): void {
    for (const [key, contribution] of this.perWorkflowUpDownCounters) {
      if (contribution.runId !== runId) continue;
      if (contribution.netValue !== 0) {
        this.getUpDownCounter(contribution.metricName, contribution.unit, contribution.description).add(
          -contribution.netValue,
          contribution.tags
        );
      }
      this.perWorkflowUpDownCounters.delete(key);
    }
  }

  private getUpDownCounter(
    name: string,
    unit: string | undefined,
    description: string | undefined
  ): MetricUpDownCounter {
    const key = metricDescriptorKey(name, unit, description);
    let counter = this.upDownCounterCache.get(key);
    if (counter === undefined) {
      counter = this.metricMeter.createUpDownCounter!(name, unit, description);
      this.upDownCounterCache.set(key, counter);
    }
    return counter;
  }
}
