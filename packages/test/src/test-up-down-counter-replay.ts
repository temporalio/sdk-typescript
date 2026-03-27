import test from 'ava';
import { MetricMeter, MetricTags, MetricUpDownCounter, noopMetricMeter } from '@temporalio/common';
import { initMetricSink, MetricSinkWithCleanup } from '@temporalio/worker/lib/workflow/metrics';

// ---- Helpers for unit tests ----

/**
 * A simple in-memory MetricMeter that tracks UpDownCounter values for assertions.
 */
class TestMetricMeter implements MetricMeter {
  readonly upDownCounterValues = new Map<string, number>();

  createCounter(name: string, _unit?: string, _description?: string) {
    return noopMetricMeter.createCounter(name, _unit, _description);
  }

  createHistogram(name: string, _valueType?: any, _unit?: string, _description?: string) {
    return noopMetricMeter.createHistogram(name, _valueType, _unit, _description);
  }

  createGauge(name: string, _valueType?: any, _unit?: string, _description?: string) {
    return noopMetricMeter.createGauge(name, _valueType, _unit, _description);
  }

  createUpDownCounter(name: string, unit?: string, description?: string): MetricUpDownCounter {
    const self = this;
    return {
      name,
      unit,
      description,
      kind: 'up_down_counter' as const,
      valueType: 'int' as const,
      add(value: number, extraTags?: MetricTags) {
        const key = `${name}:${tagsKey(extraTags ?? {})}`;
        const current = self.upDownCounterValues.get(key) ?? 0;
        self.upDownCounterValues.set(key, current + value);
      },
      withTags() {
        return this;
      },
    };
  }

  withTags() {
    return this;
  }

  /** Get the current value for a metric name + tags combo */
  getValue(name: string, tags: MetricTags = {}): number {
    return this.upDownCounterValues.get(`${name}:${tagsKey(tags)}`) ?? 0;
  }
}

function tagsKey(tags: MetricTags): string {
  return Object.keys(tags)
    .sort()
    .map((k) => `${k}=${tags[k]}`)
    .join(',');
}

function fakeWorkflowInfo(runId: string): { runId: string } {
  return { runId } as any;
}

function callSink(
  sink: MetricSinkWithCleanup,
  runId: string,
  metricName: string,
  netValue: number,
  tags: MetricTags = {}
): void {
  const sinkFn = sink.sinks.__temporal_metrics.addMetricUpDownCounterValue;
  sinkFn.fn(fakeWorkflowInfo(runId), metricName, undefined, undefined, netValue, tags);
}

// ---- Unit tests for the sink tracking logic ----

test('UpDownCounter sink - normal increment and decrement', (t) => {
  const meter = new TestMetricMeter();
  const sink = initMetricSink(meter);

  // Workflow emits netValue=1 (after add(1))
  callSink(sink, 'run-1', 'inflight', 1);
  t.is(meter.getValue('inflight'), 1);

  // Workflow emits netValue=0 (after add(-1))
  callSink(sink, 'run-1', 'inflight', 0);
  t.is(meter.getValue('inflight'), 0);
});

test('UpDownCounter sink - multiple workflows tracked independently', (t) => {
  const meter = new TestMetricMeter();
  const sink = initMetricSink(meter);

  callSink(sink, 'run-1', 'inflight', 1);
  callSink(sink, 'run-2', 'inflight', 1);
  t.is(meter.getValue('inflight'), 2);

  callSink(sink, 'run-1', 'inflight', 0);
  t.is(meter.getValue('inflight'), 1);

  callSink(sink, 'run-2', 'inflight', 0);
  t.is(meter.getValue('inflight'), 0);
});

test('UpDownCounter sink - cleanup undoes workflow contributions on eviction', (t) => {
  const meter = new TestMetricMeter();
  const sink = initMetricSink(meter);

  callSink(sink, 'run-1', 'inflight', 1);
  callSink(sink, 'run-2', 'inflight', 1);
  t.is(meter.getValue('inflight'), 2);

  // Evict workflow run-1
  sink.cleanupWorkflow('run-1');
  t.is(meter.getValue('inflight'), 1);

  // Evict workflow run-2
  sink.cleanupWorkflow('run-2');
  t.is(meter.getValue('inflight'), 0);
});

test('UpDownCounter sink - cleanup is idempotent', (t) => {
  const meter = new TestMetricMeter();
  const sink = initMetricSink(meter);

  callSink(sink, 'run-1', 'inflight', 1);
  t.is(meter.getValue('inflight'), 1);

  sink.cleanupWorkflow('run-1');
  t.is(meter.getValue('inflight'), 0);

  // Second cleanup should be a no-op
  sink.cleanupWorkflow('run-1');
  t.is(meter.getValue('inflight'), 0);
});

test('UpDownCounter sink - cache eviction then replay on same process', (t) => {
  const meter = new TestMetricMeter();
  const sink = initMetricSink(meter);

  // Original execution: workflow increments
  callSink(sink, 'run-1', 'inflight', 1);
  t.is(meter.getValue('inflight'), 1);

  // Workflow evicted from cache
  sink.cleanupWorkflow('run-1');
  t.is(meter.getValue('inflight'), 0);

  // Replay rebuilds net value: sandbox starts fresh, emits netValue=1 again
  callSink(sink, 'run-1', 'inflight', 1);
  t.is(meter.getValue('inflight'), 1, 'replay correctly rebuilds the metric');

  // Continue execution: workflow decrements
  callSink(sink, 'run-1', 'inflight', 0);
  t.is(meter.getValue('inflight'), 0);
});

test('UpDownCounter sink - worker restart simulation (fresh sink, same meter)', (t) => {
  const meter = new TestMetricMeter();

  // Worker 1: workflow increments
  const sink1 = initMetricSink(meter);
  callSink(sink1, 'run-1', 'inflight', 1);
  t.is(meter.getValue('inflight'), 1);

  // Worker 1 dies: eviction cleanup
  sink1.cleanupWorkflow('run-1');
  t.is(meter.getValue('inflight'), 0);

  // Worker 2: new sink, replay rebuilds
  const sink2 = initMetricSink(meter);
  callSink(sink2, 'run-1', 'inflight', 1);
  t.is(meter.getValue('inflight'), 1, 'new worker correctly rebuilds via replay');

  // Continue: workflow decrements
  callSink(sink2, 'run-1', 'inflight', 0);
  t.is(meter.getValue('inflight'), 0);
});

test('UpDownCounter sink - replay with no prior tracking (pure new process)', (t) => {
  const meter = new TestMetricMeter();
  const sink = initMetricSink(meter);

  // Replay: no prior state exists, netValue=1 is the replay result
  callSink(sink, 'run-1', 'inflight', 1);
  t.is(meter.getValue('inflight'), 1);

  // New execution after replay: decrement
  callSink(sink, 'run-1', 'inflight', 0);
  t.is(meter.getValue('inflight'), 0);
});

test('UpDownCounter sink - different tags tracked separately', (t) => {
  const meter = new TestMetricMeter();
  const sink = initMetricSink(meter);

  callSink(sink, 'run-1', 'inflight', 1, { product: 'clinician-api' });
  callSink(sink, 'run-1', 'inflight', 1, { product: 'epic-haiku' });
  t.is(meter.getValue('inflight', { product: 'clinician-api' }), 1);
  t.is(meter.getValue('inflight', { product: 'epic-haiku' }), 1);

  // Cleanup undoes all tag combos for the workflow
  sink.cleanupWorkflow('run-1');
  t.is(meter.getValue('inflight', { product: 'clinician-api' }), 0);
  t.is(meter.getValue('inflight', { product: 'epic-haiku' }), 0);
});

test('UpDownCounter sink - multiple metrics tracked independently', (t) => {
  const meter = new TestMetricMeter();
  const sink = initMetricSink(meter);

  callSink(sink, 'run-1', 'metric_a', 5);
  callSink(sink, 'run-1', 'metric_b', 3);
  t.is(meter.getValue('metric_a'), 5);
  t.is(meter.getValue('metric_b'), 3);

  sink.cleanupWorkflow('run-1');
  t.is(meter.getValue('metric_a'), 0);
  t.is(meter.getValue('metric_b'), 0);
});

test('UpDownCounter sink - net value going negative is handled', (t) => {
  const meter = new TestMetricMeter();
  const sink = initMetricSink(meter);

  // Simulate a workflow that decrements below 0 (e.g., buggy code)
  callSink(sink, 'run-1', 'counter', -1);
  t.is(meter.getValue('counter'), -1);

  // Cleanup correctly undoes the negative contribution
  sink.cleanupWorkflow('run-1');
  t.is(meter.getValue('counter'), 0);
});

test('UpDownCounter sink - delta-only behavior (no change when netValue unchanged)', (t) => {
  const meter = new TestMetricMeter();
  const sink = initMetricSink(meter);

  callSink(sink, 'run-1', 'inflight', 1);
  t.is(meter.getValue('inflight'), 1);

  // Same netValue emitted again (e.g., during replay hitting same point)
  callSink(sink, 'run-1', 'inflight', 1);
  t.is(meter.getValue('inflight'), 1, 'no double-counting when same netValue is emitted');
});

test('UpDownCounter sink - callDuringReplay is true', (t) => {
  const meter = new TestMetricMeter();
  const sink = initMetricSink(meter);

  const upDownCounterSink = sink.sinks.__temporal_metrics.addMetricUpDownCounterValue;
  t.is(upDownCounterSink.callDuringReplay, true, 'UpDownCounter sink must be called during replay');

  // Other metric sinks should NOT be called during replay
  const counterSink = sink.sinks.__temporal_metrics.addMetricCounterValue;
  t.is(counterSink.callDuringReplay, false, 'Counter sink should not be called during replay');
});

test('UpDownCounter sink - full lifecycle: increment, evict, replay, complete, evict', (t) => {
  const meter = new TestMetricMeter();
  const sink = initMetricSink(meter);

  // 1. Two workflows start: both increment
  callSink(sink, 'run-1', 'inflight', 1);
  callSink(sink, 'run-2', 'inflight', 1);
  t.is(meter.getValue('inflight'), 2, 'both workflows inflight');

  // 2. Worker shuts down: both evicted
  sink.cleanupWorkflow('run-1');
  sink.cleanupWorkflow('run-2');
  t.is(meter.getValue('inflight'), 0, 'metric zeroed after eviction');

  // 3. New worker replays both workflows (rebuilds add(1) for each)
  callSink(sink, 'run-1', 'inflight', 1);
  callSink(sink, 'run-2', 'inflight', 1);
  t.is(meter.getValue('inflight'), 2, 'replay rebuilds inflight count');

  // 4. Both workflows complete: decrement
  callSink(sink, 'run-1', 'inflight', 0);
  callSink(sink, 'run-2', 'inflight', 0);
  t.is(meter.getValue('inflight'), 0, 'both workflows completed');

  // 5. Final eviction (workflow completion)
  sink.cleanupWorkflow('run-1');
  sink.cleanupWorkflow('run-2');
  t.is(meter.getValue('inflight'), 0, 'clean after final eviction');
});
