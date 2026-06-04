/**
 * Internal-query filtering end-to-end.
 *
 * Temporal issues internal queries (`__stack_trace`, `__temporal_*`) against
 * running workflows for tooling and stack inspection. The inbound query
 * interceptor must NOT emit a LangSmith run for those — only for genuine user
 * queries. This boots a real environment, queries both a user query and the
 * built-in `__stack_trace`, and asserts only the user query produced a run.
 *
 * @module
 */

process.env.LANGSMITH_TRACING = 'true';

import test from 'ava';

import * as activities from './activities/langsmith';
import { InMemoryRunCollector, withTracingWorker } from './helpers';
import * as workflows from './workflows/langsmith';

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
      // A real user query — should produce a HandleQuery run.
      await handle.query(workflows.myQuery);
      // A Temporal-internal query — must be filtered out.
      await handle.query('__stack_trace');
      // Release the workflow's wait and let it complete.
      await handle.signal(workflows.completeSignal);
      await handle.result();
    },
  });

  t.truthy(collector.byName('HandleQuery:my_query'));
  t.is(collector.byName('HandleQuery:__stack_trace'), undefined);
});
