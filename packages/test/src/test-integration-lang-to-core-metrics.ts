import * as workflow from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
});

const metricMeter = workflow.metricsMeter.withTags({ labelX: 'value-x', labelY: 'value-y' });

const myCounterMetric = metricMeter.createCounter('my-counter', 'my-counter-unit', 'my-counter-description');
const myHistogramMetric = metricMeter.createHistogram(
  'my-histogram',
  'int',
  'my-histogram-unit',
  'my-histogram-description'
);
const myGaugeMetric = metricMeter.createGauge('my-gauge', 'int', 'my-gauge-unit', 'my-gauge-description');

export async function metricsWorkflowStyle2(): Promise<void> {
  myCounterMetric.add(1);
  myHistogramMetric.record(1);
  myGaugeMetric.set(1);

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

test('Workflow metrics style 2 works', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(executeWorkflow(metricsWorkflowStyle2));
  // FIXME: Assert metrics were emited
});
