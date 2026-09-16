/**
 * Internal-query filtering end-to-end.
 *
 * Temporal issues internal queries (`__stack_trace`, `__temporal_*`) against
 * running workflows for tooling and stack inspection. The inbound query
 * interceptor must NOT emit a LangSmith run for those — only for genuine user
 * queries.
 *
 * @module
 */

import test from 'ava';

import * as activities from './activities/langsmith';
import { InMemoryRunCollector, withTracingWorker, useSharedEnv } from './helpers';
import * as workflows from './workflows/langsmith';

process.env.LANGSMITH_TRACING = 'true';

useSharedEnv(test);

test('internal-query filtering: traces user queries but not Temporal-internal queries', async (t) => {
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: { addTemporalRuns: true },
    activities: { simpleActivity: activities.simpleActivity },
    body: async ({ client, taskQueue }) => {
      const handle = await client.workflow.start(workflows.HandlersWorkflow, {
        taskQueue,
        workflowId: `qf-${Date.now()}`,
      });
      await handle.query(workflows.myQuery);
      if ('bun' in process.versions) {
        await t.throwsAsync(handle.query('__stack_trace'), {
          message: /Workflow stack traces are not enabled on this worker/,
        });
      } else {
        await handle.query('__stack_trace');
      }
      await handle.signal(workflows.completeSignal);
      await handle.result();
    },
  });

  t.truthy(collector.byName('HandleQuery:my_query'));
  t.is(collector.byName('HandleQuery:__stack_trace'), undefined);
});
