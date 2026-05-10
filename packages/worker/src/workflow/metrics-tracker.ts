import { type MetricMeter, type MetricTags, type MetricUpDownCounter } from '@temporalio/common';
import type { WorkflowInfo } from '@temporalio/workflow';
import type { MetricSinks } from '@temporalio/workflow/lib/metrics';
import type { InjectedSinks } from '../sinks';

interface TrackedContribution {
  metricName: string;
  unit: string | undefined;
  description: string | undefined;
  tags: MetricTags;
  netValue: number;
}

export function stableTagsKey(tags: MetricTags): string {
  const keys = Object.keys(tags).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${tags[k]}`).join(',');
}

export class WorkflowMetricsTracker {
  private readonly perWorkflowUpDownCounters = new Map<string, TrackedContribution>();
  private readonly upDownCounterCache = new Map<string, MetricUpDownCounter>();

  constructor(private readonly metricMeter: MetricMeter) {}

  getInjectedSinks(): InjectedSinks<MetricSinks> {
    return {
      __temporal_metrics: {
        // Fields below for Counter/Histogram/Gauge are added in Task 2.
        addMetricCounterValue: { fn: () => {}, callDuringReplay: false },
        recordMetricHistogramValue: { fn: () => {}, callDuringReplay: false },
        setMetricGaugeValue: { fn: () => {}, callDuringReplay: false },
        addMetricUpDownCounterValue: {
          fn: (
            workflowInfo: WorkflowInfo,
            metricName: string,
            unit: string | undefined,
            description: string | undefined,
            netValue: number,
            attrs: MetricTags
          ) => {
            const key = `${workflowInfo.runId} ${metricName} ${stableTagsKey(attrs)}`;
            const existing = this.perWorkflowUpDownCounters.get(key);
            const oldNet = existing?.netValue ?? 0;
            const delta = netValue - oldNet;
            this.perWorkflowUpDownCounters.set(key, {
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
    const prefix = `${runId} `;
    for (const [key, contribution] of this.perWorkflowUpDownCounters) {
      if (!key.startsWith(prefix)) continue;
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
    let counter = this.upDownCounterCache.get(name);
    if (counter === undefined) {
      counter = this.metricMeter.createUpDownCounter!(name, unit, description);
      this.upDownCounterCache.set(name, counter);
    }
    return counter;
  }
}
