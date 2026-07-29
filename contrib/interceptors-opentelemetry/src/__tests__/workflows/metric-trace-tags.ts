import { metricMeter, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

const { emitOtelPluginMetric } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

export async function metricTraceTags(): Promise<void> {
  const counter = metricMeter.createCounter('otel-plugin-workflow-counter');
  counter.add(1, { source: 'workflow' });

  await emitOtelPluginMetric();
}
