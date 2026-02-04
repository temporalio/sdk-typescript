import test from 'ava';
import { MetricsBuffer, Runtime } from '@temporalio/worker';

// Asserts that:
// - Buffered metrics can be retrieved from Core
// - Metric parameters are properly reported in update events
// - A Metric object is reused across update events for the same metric
// - Metric update events contain the correct value
test.serial('Buffered Metrics - Exporting buffered metrics from Core works properly', async (t) => {
  const buffer = new MetricsBuffer({
    maxBufferSize: 1000,
    useSecondsForDurations: false,
  });
  const runtime = Runtime.install({
    telemetryOptions: {
      metrics: {
        buffer,
      },
    },
  });
  const meter = runtime.metricMeter;

  try {
    // Counter (events 0-2)
    const counter = meter.createCounter('my-counter', 'my-counter-unit', 'my-counter-description');
    counter.add(1);
    counter.add(1);
    counter.add(40); // 1+1+40 => 42

    // Int Gauge (events 3-4)
    const gaugeInt = meter.createGauge('my-int-gauge', 'int', 'my-int-gauge-unit', 'my-int-gauge-description');
    gaugeInt.set(1);
    gaugeInt.set(40);

    // Float Gauge (events 5-7)
    const gaugeFloat = meter.createGauge(
      'my-float-gauge',
      'float',
      'my-float-gauge-unit',
      'my-float-gauge-description'
    );
    gaugeFloat.set(1.1);
    gaugeFloat.set(1.1);
    gaugeFloat.set(40.1);

    // Int Histogram (events 8-10)
    const histogramInt = meter.createHistogram(
      'my-int-histogram',
      'int',
      'my-int-histogram-unit',
      'my-int-histogram-description'
    );
    histogramInt.record(20);
    histogramInt.record(200);
    histogramInt.record(2000);

    // Float Histogram (events 11-13)
    const histogramFloat = meter.createHistogram(
      'my-float-histogram',
      'float',
      'my-float-histogram-unit',
      'my-float-histogram-description'
    );
    histogramFloat.record(0.02);
    histogramFloat.record(0.07);
    histogramFloat.record(0.99);

    const updatesIterator = buffer.retrieveUpdates();

    // Metric events may include other metrics emitted by Core, which would be too
    // flaky to test here. Hence we filter out all metrics that do not start with 'my-'.
    const updates = Array.from(updatesIterator).filter((update) => update.metric.name.startsWith('my-'));
    t.is(updates.length, 14);

    t.deepEqual(updates[0].metric, {
      name: 'my-counter',
      kind: 'counter',
      valueType: 'int',
      unit: 'my-counter-unit',
      description: 'my-counter-description',
    });
    t.is(updates[0].value, 1);
    t.is(updates[1].metric, updates[0].metric);
    t.is(updates[1].value, 1);
    t.is(updates[2].metric, updates[0].metric);
    t.is(updates[2].value, 40);

    t.deepEqual(updates[3].metric, {
      name: 'my-int-gauge',
      kind: 'gauge',
      valueType: 'int',
      unit: 'my-int-gauge-unit',
      description: 'my-int-gauge-description',
    });
    t.is(updates[3].value, 1);
    t.is(updates[4].metric, updates[3].metric);
    t.is(updates[4].value, 40);

    t.deepEqual(updates[5].metric, {
      name: 'my-float-gauge',
      kind: 'gauge',
      // valueType: 'float',
      valueType: 'int', // FIXME: pending on https://github.com/temporalio/sdk-core/pull/1108
      unit: 'my-float-gauge-unit',
      description: 'my-float-gauge-description',
    });
    t.is(updates[5].value, 1.1);
    t.is(updates[6].metric, updates[5].metric);
    t.is(updates[6].value, 1.1);
    t.is(updates[7].metric, updates[5].metric);
    t.is(updates[7].value, 40.1);

    t.deepEqual(updates[8].metric, {
      name: 'my-int-histogram',
      kind: 'histogram',
      valueType: 'int',
      unit: 'my-int-histogram-unit',
      description: 'my-int-histogram-description',
    });
    t.is(updates[8].value, 20);
    t.is(updates[9].metric, updates[8].metric);
    t.is(updates[9].value, 200);
    t.is(updates[10].metric, updates[8].metric);
    t.is(updates[10].value, 2000);

    t.deepEqual(updates[11].metric, {
      name: 'my-float-histogram',
      kind: 'histogram',
      // valueType: 'float',
      valueType: 'int', // FIXME: pending on https://github.com/temporalio/sdk-core/pull/1108
      unit: 'my-float-histogram-unit',
      description: 'my-float-histogram-description',
    });
    t.is(updates[11].value, 0.02);
    t.is(updates[12].metric, updates[11].metric);
    t.is(updates[12].value, 0.07);
    t.is(updates[13].metric, updates[11].metric);
    t.is(updates[13].value, 0.99);
  } finally {
    await runtime.shutdown();
  }
});

test.serial('Buffered Metrics - Metric attributes are properly reported', async (t) => {
  const buffer = new MetricsBuffer({
    maxBufferSize: 1000,
    useSecondsForDurations: false,
  });
  const runtime = Runtime.install({
    telemetryOptions: {
      metrics: {
        buffer,
      },
    },
  });
  const meter = runtime.metricMeter;

  try {
    const counter = meter.createCounter('my-counter', 'my-counter-unit', 'my-counter-description');
    const counter2 = counter.withTags({ labelA: 'value-a', labelB: true, labelC: 123, labelD: 123.456 });

    counter2.add(1);
    counter2.add(2, { labelA: 'value-a2', labelE: 12.34 });
    counter2.add(3, { labelC: 'value-c2', labelE: 23.45 });

    const updatesIterator = buffer.retrieveUpdates();

    // Metric events may include other metrics emitted by Core, which would be too
    // flaky to test here. Hence we filter out all metrics that do not start with 'my-'.
    const updates = Array.from(updatesIterator).filter((update) => update.metric.name.startsWith('my-'));
    t.is(updates.length, 3);

    t.is(updates[0].value, 1);
    t.deepEqual(updates[0].attributes, {
      labelA: 'value-a',
      labelB: true,
      labelC: 123,
      labelD: 123.456,
    });
    t.is(updates[1].value, 2);
    t.deepEqual(updates[1].attributes, {
      labelA: 'value-a2',
      labelB: true,
      labelC: 123,
      labelD: 123.456,
      labelE: 12.34,
    });
    t.is(updates[2].value, 3);
    t.deepEqual(updates[2].attributes, {
      labelA: 'value-a',
      labelB: true,
      labelC: 'value-c2',
      labelD: 123.456,
      labelE: 23.45,
    });
  } finally {
    await runtime.shutdown();
  }
});

test.serial('Buffered Metrics - empty description and unit are reported as undefined', async (t) => {
  const buffer = new MetricsBuffer({
    maxBufferSize: 1000,
    useSecondsForDurations: false,
  });
  const runtime = Runtime.install({
    telemetryOptions: {
      metrics: {
        buffer,
      },
    },
  });
  const meter = runtime.metricMeter;

  try {
    const counter = meter.createCounter('my-counter', undefined, undefined);
    counter.add(1);

    // Metric events may include other metrics emitted by Core, which would be too
    // flaky to test here. Hence we filter out all metrics that do not start with 'my-'.
    const updatesIterator = buffer.retrieveUpdates();
    const updates = Array.from(updatesIterator).filter((update) => update.metric.name.startsWith('my-'));
    t.is(updates.length, 1);

    t.deepEqual(updates[0].metric, {
      name: 'my-counter',
      kind: 'counter',
      valueType: 'int',
      unit: undefined,
      description: undefined,
    });
    t.is(updates[0].value, 1);
  } finally {
    await runtime.shutdown();
  }
});

test.serial('Buffered Metrics - MetricsBuffer does not lose metric events on runtime shutdown', async (t) => {
  const buffer = new MetricsBuffer({
    maxBufferSize: 1000,
    useSecondsForDurations: false,
  });

  {
    const runtime = Runtime.install({
      telemetryOptions: {
        metrics: {
          buffer,
        },
      },
    });
    const meter = runtime.metricMeter;

    try {
      const counter = meter.createCounter('my-counter', undefined, undefined);
      counter.add(1);

      const updatesIterator = buffer.retrieveUpdates();
      const updates = Array.from(updatesIterator).filter((update) => update.metric.name === 'my-counter');
      t.is(updates.length, 1);
      t.is(updates[0].value, 1);

      // That metric event should not be lost; we'll retrieve it after the runtime is shut down.
      counter.add(2);
    } finally {
      await runtime.shutdown();
    }
  }

  {
    // This will create a new runtime instance, reusing the previous RuntimeOptions.
    // That notably means that the same MetricsBuffer instance will be reused.
    // This is the behavior we want to test here.
    const runtime = Runtime.instance();
    const meter = runtime.metricMeter;

    try {
      const counter = meter.createCounter('my-counter', undefined, undefined);
      counter.add(3);

      const updatesIterator = buffer.retrieveUpdates();
      const updates = Array.from(updatesIterator).filter((update) => update.metric.name === 'my-counter');
      t.is(updates.length, 2);
      t.is(updates[0].value, 2);
      t.is(updates[1].value, 3);

      // That metric event should not be lost; we'll retrieve it after the runtime is shut down.
      counter.add(4);
    } finally {
      await runtime.shutdown();
    }
  }

  {
    const updatesIterator = buffer.retrieveUpdates();
    const updates = Array.from(updatesIterator).filter((update) => update.metric.name === 'my-counter');
    t.is(updates.length, 1);
    t.is(updates[0].value, 4);
  }
});
