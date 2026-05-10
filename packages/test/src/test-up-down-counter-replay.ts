import test from 'ava';
import type {
  MetricMeter,
  MetricTags,
  MetricUpDownCounter,
  MetricCounter,
  MetricHistogram,
  MetricGauge,
  NumericMetricValueType,
} from '@temporalio/common';
import { WorkflowMetricsTracker } from '@temporalio/worker/lib/workflow/metrics-tracker';

interface RecordedAdd {
  name: string;
  value: number;
  tags: MetricTags;
}

class FakeUpDownCounter implements MetricUpDownCounter {
  public readonly kind = 'up-down-counter' as const;
  public readonly valueType = 'int' as const;
  constructor(
    public readonly name: string,
    public readonly unit: string | undefined,
    public readonly description: string | undefined,
    private readonly recorded: RecordedAdd[]
  ) {}
  add(value: number, tags: MetricTags = {}): void {
    this.recorded.push({ name: this.name, value, tags });
  }
  withTags(_tags: MetricTags): MetricUpDownCounter {
    throw new Error('not used in this test');
  }
}

class FakeMetricMeter implements MetricMeter {
  public readonly recorded: RecordedAdd[] = [];
  createCounter(_n: string, _u?: string, _d?: string): MetricCounter {
    throw new Error('unused');
  }
  createHistogram(
    _n: string,
    _v?: NumericMetricValueType,
    _u?: string,
    _d?: string
  ): MetricHistogram {
    throw new Error('unused');
  }
  createGauge(_n: string, _v?: NumericMetricValueType, _u?: string, _d?: string): MetricGauge {
    throw new Error('unused');
  }
  createUpDownCounter(name: string, unit?: string, description?: string): MetricUpDownCounter {
    return new FakeUpDownCounter(name, unit, description, this.recorded);
  }
  withTags(_t: MetricTags): MetricMeter {
    throw new Error('unused');
  }
}

function callUpDownCounterSink(
  tracker: WorkflowMetricsTracker,
  runId: string,
  name: string,
  netValue: number,
  attrs: MetricTags = {}
) {
  const sinks = tracker.getInjectedSinks();
  const fn = sinks.__temporal_metrics.addMetricUpDownCounterValue.fn;
  void fn({ runId } as any, name, undefined, undefined, netValue, attrs);
}

test('first emission applies full delta', (t) => {
  const meter = new FakeMetricMeter();
  const tracker = new WorkflowMetricsTracker(meter);
  callUpDownCounterSink(tracker, 'run-1', 'inflight', 5);
  t.deepEqual(meter.recorded, [{ name: 'inflight', value: 5, tags: {} }]);
});
