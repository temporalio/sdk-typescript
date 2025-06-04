import { ExecutionContext } from 'ava';
import { ActivityInboundCallsInterceptor, ActivityOutboundCallsInterceptor, Runtime } from '@temporalio/worker';
import * as workflow from '@temporalio/workflow';
import { MetricTags } from '@temporalio/common';
import { Context as ActivityContext, metricMeter as activityMetricMeter } from '@temporalio/activity';
import { Context as BaseContext, helpers, makeTestFunction } from './helpers-integration';
import { getRandomPort } from './helpers';

interface Context extends BaseContext {
  port: number;
}

const test = makeTestFunction<Context>({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
  runtimeOpts: async () => {
    const port = await getRandomPort();
    return [
      {
        telemetryOptions: {
          metrics: {
            metricPrefix: 'foo_',
            prometheus: {
              bindAddress: `127.0.0.1:${port}`,
              histogramBucketOverrides: {
                'my-float-histogram': [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1],
                'workflow-float-histogram': [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1],
              },
            },
          },
        },
      },
      { port },
    ];
  },
});

async function assertMetricReported(t: ExecutionContext<Context>, regexp: RegExp) {
  const resp = await fetch(`http://127.0.0.1:${t.context.port}/metrics`);
  const text = await resp.text();
  const matched = t.regex(text, regexp);
  if (!matched) {
    t.log(text);
  }
}

/**
 * Asserts custom metrics works properly at the bridge level.
 */
test('Custom Metrics - Bridge supports works properly (no tags)', async (t) => {
  const meter = Runtime.instance().metricMeter;

  // Counter
  const counter = meter.createCounter('my-counter', 'my-counter-unit', 'my-counter-description');
  counter.add(1);
  counter.add(1);
  counter.add(40); // 1+1+40 => 42
  await assertMetricReported(t, /my_counter 42/);

  // Int Gauge
  const gaugeInt = meter.createGauge('my-int-gauge', 'int', 'my-int-gauge-description');
  gaugeInt.set(1);
  gaugeInt.set(40);
  await assertMetricReported(t, /my_int_gauge 40/);

  // Float Gauge
  const gaugeFloat = meter.createGauge('my-float-gauge', 'float', 'my-float-gauge-description');
  gaugeFloat.set(1.1);
  gaugeFloat.set(1.1);
  gaugeFloat.set(40.1);
  await assertMetricReported(t, /my_float_gauge 40.1/);

  // Int Histogram
  const histogramInt = meter.createHistogram('my-int-histogram', 'int', 'my-int-histogram-description');
  histogramInt.record(20);
  histogramInt.record(200);
  histogramInt.record(2000);
  await assertMetricReported(t, /my_int_histogram_bucket{le="50"} 1/);
  await assertMetricReported(t, /my_int_histogram_bucket{le="500"} 2/);
  await assertMetricReported(t, /my_int_histogram_bucket{le="10000"} 3/);

  // Float Histogram
  const histogramFloat = meter.createHistogram('my-float-histogram', 'float', 'my-float-histogram-description');
  histogramFloat.record(0.02);
  histogramFloat.record(0.07);
  histogramFloat.record(0.99);
  await assertMetricReported(t, /my_float_histogram_bucket{le="0.05"} 1/);
  await assertMetricReported(t, /my_float_histogram_bucket{le="0.1"} 2/);
  await assertMetricReported(t, /my_float_histogram_bucket{le="1"} 3/);
});

/**
 * Asserts custom metrics tags composition works properly
 */
test('Custom Metrics - Tags composition works properly', async (t) => {
  const meter = Runtime.instance().metricMeter;

  // Counter
  const counter = meter.createCounter('my-counter', 'my-counter-unit', 'my-counter-description');
  counter.add(1, { labelA: 'value-a', labelB: true, labelC: 123, labelD: 123.456 });
  await assertMetricReported(t, /my_counter{labelA="value-a",labelB="true",labelC="123",labelD="123.456"} 1/);

  // Int Gauge
  const gaugeInt = meter.createGauge('my-int-gauge', 'int', 'my-int-gauge-description');
  gaugeInt.set(1, { labelA: 'value-a', labelB: true, labelC: 123, labelD: 123.456 });
  await assertMetricReported(t, /my_int_gauge{labelA="value-a",labelB="true",labelC="123",labelD="123.456"} 1/);

  // Float Gauge
  const gaugeFloat = meter.createGauge('my-float-gauge', 'float', 'my-float-gauge-description');
  gaugeFloat.set(1.2, { labelA: 'value-a', labelB: true, labelC: 123, labelD: 123.456 });
  await assertMetricReported(t, /my_float_gauge{labelA="value-a",labelB="true",labelC="123",labelD="123.456"} 1.2/);

  // Int Histogram
  const histogramInt = meter.createHistogram('my-int-histogram', 'int', 'my-int-histogram-description');
  histogramInt.record(1, { labelA: 'value-a', labelB: true, labelC: 123, labelD: 123.456 });
  await assertMetricReported(
    t,
    /my_int_histogram_bucket{labelA="value-a",labelB="true",labelC="123",labelD="123.456",le="50"} 1/
  );

  // Float Histogram
  const histogramFloat = meter.createHistogram('my-float-histogram', 'float', 'my-float-histogram-description');
  histogramFloat.record(0.4, { labelA: 'value-a', labelB: true, labelC: 123, labelD: 123.456 });
  await assertMetricReported(
    t,
    /my_float_histogram_bucket{labelA="value-a",labelB="true",labelC="123",labelD="123.456",le="0.5"} 1/
  );
});

export async function metricWorksWorkflow(): Promise<void> {
  const metricMeter = workflow.metricMeter;

  const myCounterMetric = metricMeter.createCounter(
    'workflow-counter',
    'workflow-counter-unit',
    'workflow-counter-description'
  );
  const myHistogramMetric = metricMeter.createHistogram(
    'workflow-histogram',
    'int',
    'workflow-histogram-unit',
    'workflow-histogram-description'
  );
  const myFloatHistogramMetric = metricMeter.createHistogram(
    'workflow-float-histogram',
    'float',
    'workflow-float-histogram-unit',
    'workflow-float-histogram-description'
  );
  const myGaugeMetric = metricMeter.createGauge(
    'workflow-gauge',
    'int',
    'workflow-gauge-unit',
    'workflow-gauge-description'
  );
  const myFloatGaugeMetric = metricMeter.createGauge(
    'workflow-float-gauge',
    'float',
    'workflow-float-gauge-unit',
    'workflow-float-gauge-description'
  );

  myCounterMetric.add(1);
  myHistogramMetric.record(1);
  myFloatHistogramMetric.record(0.01);
  myGaugeMetric.set(1);
  myFloatGaugeMetric.set(0.1);

  // Pause here, so that we can force replay to a distinct worker
  let signalReceived = false;
  workflow.setHandler(workflow.defineUpdate('checkpoint'), () => {});
  workflow.setHandler(workflow.defineSignal('unblock'), () => {
    signalReceived = true;
  });
  await workflow.condition(() => signalReceived);

  myCounterMetric.add(3);
  myHistogramMetric.record(3);
  myFloatHistogramMetric.record(0.03);
  myGaugeMetric.set(3);
  myFloatGaugeMetric.set(0.3);
}

test('Metric in Workflow works and are not replayed', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({
    // Avoid delay when transitioning to the second worker
    stickyQueueScheduleToStartTimeout: '100ms',
  });

  const [handle1, handle2] = await worker.runUntil(async () => {
    // Start two workflows, and wait for both to reach the checkpoint.
    // Why two workflows? To confirm that there's no problem in having multiple
    // workflows and sink reinstantiating a same metric.
    return await Promise.all([
      // FIXME: Add support for Update with Start to our internal test helpers
      startWorkflow(metricWorksWorkflow).then(async (handle) => {
        await handle.executeUpdate('checkpoint');
        return handle;
      }),
      startWorkflow(metricWorksWorkflow).then(async (handle) => {
        await handle.executeUpdate('checkpoint');
        return handle;
      }),
    ]);
  });

  await assertMetricReported(t, /workflow_counter{[^}]+} 2/); // 1 + 1
  await assertMetricReported(t, /workflow_histogram_bucket{[^}]+?,le="50"} 2/);
  await assertMetricReported(t, /workflow_float_histogram_bucket{[^}]+?,le="0.05"} 2/);
  await assertMetricReported(t, /workflow_gauge{[^}]+} 1/);
  await assertMetricReported(t, /workflow_float_gauge{[^}]+} 0.1/);

  const worker2 = await createWorker();
  await worker2.runUntil(async () => {
    await Promise.all([handle1.signal('unblock'), handle2.signal('unblock')]);
    await Promise.all([handle1.result(), handle2.result()]);
  });

  await assertMetricReported(t, /workflow_counter{[^}]+} 8/); // 1 + 1 + 3 + 3
  await assertMetricReported(t, /workflow_histogram_bucket{[^}]+?,le="50"} 4/);
  await assertMetricReported(t, /workflow_float_histogram_bucket{[^}]+?,le="0.05"} 4/);
  await assertMetricReported(t, /workflow_gauge{[^}]+} 3/);
  await assertMetricReported(t, /workflow_float_gauge{[^}]+} 0.3/);
});

export async function MetricTagsWorkflow(): Promise<void> {
  const metricMeter = workflow.metricMeter.withTags({ labelX: 'value-x', labelY: 'value-y' });

  const myCounterMetric = metricMeter.createCounter(
    'workflow2-counter',
    'workflow2-counter-unit',
    'workflow2-counter-description'
  );
  const myHistogramMetric = metricMeter.createHistogram(
    'workflow2-histogram',
    'int',
    'workflow2-histogram-unit',
    'workflow2-histogram-description'
  );
  const myGaugeMetric = metricMeter.createGauge(
    'workflow2-gauge',
    'int',
    'workflow2-gauge-unit',
    'workflow2-gauge-description'
  );

  myCounterMetric
    .withTags({ labelA: 'value-a', labelB: 'value-b' })
    .withTags({ labelC: 'value-c', labelB: 'value-b2' })
    .add(2, { labelD: 'value-d' });

  myHistogramMetric
    .withTags({ labelA: 'value-a', labelB: 'value-b' })
    .withTags({ labelC: 'value-c', labelB: 'value-b2' })
    .record(2, { labelD: 'value-d' });

  myGaugeMetric
    .withTags({ labelA: 'value-a', labelB: 'value-b' })
    .withTags({ labelC: 'value-c', labelB: 'value-b2' })
    .set(2, { labelD: 'value-d' });
}

test('Metric tags in Workflow works', async (t) => {
  const { createWorker, executeWorkflow, taskQueue } = helpers(t);
  const tags = `labelA="value-a",labelB="value-b2",labelC="value-c",labelD="value-d",labelX="value-x",labelY="value-y",namespace="default",taskQueue="${taskQueue}",workflowType="MetricTagsWorkflow"`;

  const worker = await createWorker();
  await worker.runUntil(executeWorkflow(MetricTagsWorkflow));

  await assertMetricReported(t, new RegExp(`workflow2_counter{${tags}} 2`));
  await assertMetricReported(t, new RegExp(`workflow2_histogram_bucket{${tags},le="50"} 1`));
  await assertMetricReported(t, new RegExp(`workflow2_gauge{${tags}} 2`));
});

// Define workflow interceptor for metrics
export const interceptors = (): workflow.WorkflowInterceptors => ({
  outbound: [
    {
      getMetricTags(tags: MetricTags): MetricTags {
        if (!workflow.workflowInfo().workflowType.includes('Interceptor')) return tags;
        return {
          ...tags,
          intercepted: 'workflow-interceptor',
        };
      },
    },
  ],
});

// Define activity interceptor for metrics
export function activityInterceptorFactory(_ctx: ActivityContext): {
  inbound?: ActivityInboundCallsInterceptor;
  outbound?: ActivityOutboundCallsInterceptor;
} {
  return {
    outbound: {
      getMetricTags(tags: MetricTags): MetricTags {
        return {
          ...tags,
          intercepted: 'activity-interceptor',
        };
      },
    },
  };
}

// Activity that uses metrics
export async function metricActivity(): Promise<void> {
  const { metricMeter } = ActivityContext.current();

  const counter = metricMeter.createCounter('activity-counter');
  counter.add(5);

  const histogram = metricMeter.createHistogram('activity-histogram');
  histogram.record(10);

  // Use the `metricMeter` exported from the top level of the activity module rather than the one in the context
  const gauge = activityMetricMeter.createGauge('activity-gauge');
  gauge.set(15);
}

// Workflow that uses metrics and calls the activity
export async function metricsInterceptorWorkflow(): Promise<void> {
  const metricMeter = workflow.metricMeter;

  // Use workflow metrics
  const counter = metricMeter.createCounter('intercepted-workflow-counter');
  counter.add(3);

  const histogram = metricMeter.createHistogram('intercepted-workflow-histogram');
  histogram.record(6);

  const gauge = metricMeter.createGauge('intercepted-workflow-gauge');
  gauge.set(9);

  // Call activity with metrics
  await workflow
    .proxyActivities({
      startToCloseTimeout: '1 minute',
    })
    .metricActivity();
}

// Test for workflow metrics interceptor
test('Workflow and Activity Context metrics interceptors add tags', async (t) => {
  const { createWorker, executeWorkflow, taskQueue } = helpers(t);

  const worker = await createWorker({
    taskQueue,
    workflowsPath: __filename,
    activities: {
      metricActivity,
    },
    interceptors: {
      activity: [activityInterceptorFactory],
    },
  });

  await worker.runUntil(executeWorkflow(metricsInterceptorWorkflow));

  // Verify workflow metrics have interceptor tag
  await assertMetricReported(t, /intercepted_workflow_counter{[^}]*intercepted="workflow-interceptor"[^}]*} 3/);
  await assertMetricReported(
    t,
    /intercepted_workflow_histogram_bucket{[^}]*intercepted="workflow-interceptor"[^}]*} \d+/
  );
  await assertMetricReported(t, /intercepted_workflow_gauge{[^}]*intercepted="workflow-interceptor"[^}]*} 9/);

  // Verify activity metrics have interceptor tag
  await assertMetricReported(t, /activity_counter{[^}]*intercepted="activity-interceptor"[^}]*} 5/);
  await assertMetricReported(t, /activity_histogram_bucket{[^}]*intercepted="activity-interceptor"[^}]*} \d+/);
  await assertMetricReported(t, /activity_gauge{[^}]*intercepted="activity-interceptor"[^}]*} 15/);
});
