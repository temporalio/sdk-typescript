import { ExecutionContext } from 'ava';
import { Runtime } from '@temporalio/worker';
import { Context, makeTestFunction } from './helpers-integration';

// interface Context extends BaseContext {
//   port: number;
// }

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
  runtimeOpts: {
    telemetryOptions: {
      metrics: {
        metricPrefix: 'foo_',
        prometheus: {
          bindAddress: `127.0.0.1:9875`, // FIXME: Use a random port
        },
      },
    },
  },
});

async function assertMetricsReported(t: ExecutionContext<Context>, regexp: RegExp) {
  const resp = await fetch(`http://127.0.0.1:9875/metrics`);
  const text = await resp.text();
  const matched = t.regex(text, regexp);
  if (!matched) {
    t.log(text);
  }
}

/**
 * Asserts custom metrics works properly at the bridge level.
 */
test('Custom Metrics - Bridge supports works properly', async (t) => {
  const meter = Runtime.instance().metricMeter;

  // Counter - Without tags
  const counter = meter.createCounter('my-counter', 'my-counter-unit', 'my-counter-description');
  counter.add(1);
  counter.add(1);
  counter.add(40); // 1+1+40 => 42
  await assertMetricsReported(t, /my_counter 42/);

  // Counter - With tags
  counter.add(1, { labelA: 'value-a', labelB: true, labelC: 123, labelD: 123.456 });
  await assertMetricsReported(t, /my_counter{labelA="value-a",labelB="true",labelC="123",labelD="123.456"} 1/);

  // Int Gauge - Without tags
  const gaugeInt = meter.createGauge('my-int-gauge', 'int', 'my-int-gauge-description');
  gaugeInt.set(1);
  gaugeInt.set(40);
  await assertMetricsReported(t, /my_int_gauge 40/);

  // Int Gauge - With tags
  gaugeInt.set(1, { labelA: 'value-a', labelB: true, labelC: 123, labelD: 123.456 });
  await assertMetricsReported(t, /my_int_gauge{labelA="value-a",labelB="true",labelC="123",labelD="123.456"} 1/);

  // Float Gauge - Without tags
  const gaugeFloat = meter.createGauge('my-float-gauge', 'float', 'my-float-gauge-description');
  gaugeFloat.set(1.1);
  gaugeFloat.set(1.1);
  gaugeFloat.set(40.1);
  await assertMetricsReported(t, /my_float_gauge 40.1/);

  // Float Gauge - With tags
  gaugeFloat.set(1.2, { labelA: 'value-a', labelB: true, labelC: 123, labelD: 123.456 });
  await assertMetricsReported(t, /my_float_gauge{labelA="value-a",labelB="true",labelC="123",labelD="123.456"} 1.2/);

  // Int Histogram - Without tags
  const histogramInt = meter.createHistogram('my-int-histogram', 'int', 'my-int-histogram-description');
  histogramInt.record(20);
  histogramInt.record(200);
  histogramInt.record(2000);
  await assertMetricsReported(t, /my_int_histogram_bucket{le="50"} 1/);
  await assertMetricsReported(t, /my_int_histogram_bucket{le="500"} 2/);
  await assertMetricsReported(t, /my_int_histogram_bucket{le="10000"} 3/);

  // Int Histogram - With tags
  histogramInt.record(1, { labelA: 'value-a', labelB: true, labelC: 123, labelD: 123.456 });
  await assertMetricsReported(
    t,
    /my_int_histogram_bucket{labelA="value-a",labelB="true",labelC="123",labelD="123.456",le="50"} 1/
  );

  // Float Histogram - Without tags
  const histogramFloat = meter.createHistogram('my-float-histogram', 'float', 'my-float-histogram-description');
  histogramFloat.record(20);
  histogramFloat.record(200);
  histogramFloat.record(2000);
  await assertMetricsReported(t, /my_float_histogram_bucket{le="50"} 1/);
  await assertMetricsReported(t, /my_float_histogram_bucket{le="500"} 2/);
  await assertMetricsReported(t, /my_float_histogram_bucket{le="10000"} 3/);

  // Float Histogram - With tags
  histogramFloat.record(1.2, { labelA: 'value-a', labelB: true, labelC: 123, labelD: 123.456 });
  await assertMetricsReported(
    t,
    /my_float_histogram_bucket{labelA="value-a",labelB="true",labelC="123",labelD="123.456",le="50"} 1/
  );
});

//////////////

// const metricMeter = workflow.metricsMeter.withTags({ labelX: 'value-x', labelY: 'value-y' });

// const myCounterMetric = metricMeter.createCounter('my-counter', 'my-counter-unit', 'my-counter-description');
// const myHistogramMetric = metricMeter.createHistogram(
//   'my-histogram',
//   'int',
//   'my-histogram-unit',
//   'my-histogram-description'
// );
// const myGaugeMetric = metricMeter.createGauge('my-gauge', 'int', 'my-gauge-unit', 'my-gauge-description');

// export async function metricsWorkflowStyle2(): Promise<void> {
//   myCounterMetric.add(1);
//   myHistogramMetric.record(1);
//   myGaugeMetric.set(1);

//   myCounterMetric
//     .withTags({ labelA: 'value-a', labelB: 'value-b' })
//     .withTags({ labelC: 'value-c', labelB: 'value-b2' })
//     .add(2, { labelD: 'value-d' });
//   myHistogramMetric
//     .withTags({ labelA: 'value-a', labelB: 'value-b' })
//     .withTags({ labelC: 'value-c', labelB: 'value-b2' })
//     .record(2, { labelD: 'value-d' });
//   myGaugeMetric
//     .withTags({ labelA: 'value-a', labelB: 'value-b' })
//     .withTags({ labelC: 'value-c', labelB: 'value-b2' })
//     .set(2, { labelD: 'value-d' });
// }

// test('Workflow metrics style 2 works', async (t) => {
//   const { createWorker, executeWorkflow } = helpers(t);
//   const worker = await createWorker();
//   await worker.runUntil(executeWorkflow(metricsWorkflowStyle2));
//   // FIXME: Assert metrics were emited
// });
