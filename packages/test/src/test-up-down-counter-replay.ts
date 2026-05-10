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

test('idempotent re-emission with same net value applies no delta', (t) => {
  const meter = new FakeMetricMeter();
  const tracker = new WorkflowMetricsTracker(meter);
  callUpDownCounterSink(tracker, 'run-1', 'inflight', 5);
  callUpDownCounterSink(tracker, 'run-1', 'inflight', 5);
  t.deepEqual(meter.recorded, [{ name: 'inflight', value: 5, tags: {} }]);
});

test('different tag combinations are tracked independently', (t) => {
  const meter = new FakeMetricMeter();
  const tracker = new WorkflowMetricsTracker(meter);
  callUpDownCounterSink(tracker, 'run-1', 'inflight', 1, { region: 'us' });
  callUpDownCounterSink(tracker, 'run-1', 'inflight', 1, { region: 'eu' });
  callUpDownCounterSink(tracker, 'run-1', 'inflight', 3, { region: 'us' });
  t.deepEqual(meter.recorded, [
    { name: 'inflight', value: 1, tags: { region: 'us' } },
    { name: 'inflight', value: 1, tags: { region: 'eu' } },
    { name: 'inflight', value: 2, tags: { region: 'us' } },
  ]);
});

test('negative net values produce negative deltas', (t) => {
  const meter = new FakeMetricMeter();
  const tracker = new WorkflowMetricsTracker(meter);
  callUpDownCounterSink(tracker, 'run-1', 'inflight', 1);
  callUpDownCounterSink(tracker, 'run-1', 'inflight', -2);
  t.deepEqual(meter.recorded, [
    { name: 'inflight', value: 1, tags: {} },
    { name: 'inflight', value: -3, tags: {} },
  ]);
});

test('notifyWorkflowEvicted undoes contributions for that runId only', (t) => {
  const meter = new FakeMetricMeter();
  const tracker = new WorkflowMetricsTracker(meter);
  callUpDownCounterSink(tracker, 'run-A', 'inflight', 4);
  callUpDownCounterSink(tracker, 'run-B', 'inflight', 7);
  tracker.notifyWorkflowEvicted('run-A');
  t.deepEqual(meter.recorded, [
    { name: 'inflight', value: 4, tags: {} },
    { name: 'inflight', value: 7, tags: {} },
    { name: 'inflight', value: -4, tags: {} },
  ]);
});

test('notifyWorkflowEvicted with no contributions is a no-op', (t) => {
  const meter = new FakeMetricMeter();
  const tracker = new WorkflowMetricsTracker(meter);
  callUpDownCounterSink(tracker, 'run-A', 'inflight', 0);
  tracker.notifyWorkflowEvicted('run-A');
  // The first emission (netValue=0) results in delta=0 → no native add.
  // Eviction has nothing to undo.
  t.deepEqual(meter.recorded, []);
});

test('full lifecycle: emit, evict, re-emit reaches steady state', (t) => {
  const meter = new FakeMetricMeter();
  const tracker = new WorkflowMetricsTracker(meter);
  callUpDownCounterSink(tracker, 'run-A', 'inflight', 1);
  tracker.notifyWorkflowEvicted('run-A');
  callUpDownCounterSink(tracker, 'run-A', 'inflight', 1);
  // Sum of recorded values: 1 + (-1) + 1 = 1
  const sum = meter.recorded.reduce((acc, r) => acc + r.value, 0);
  t.is(sum, 1);
});
