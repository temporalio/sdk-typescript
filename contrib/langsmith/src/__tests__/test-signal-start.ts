/**
 * Start-with-signal ordering under the LangSmith signal inbound interceptor.
 *
 * The workflow buffers the start signal until after activity `a`, installs an
 * async signal handler that awaits activity `b`, then schedules activity `c`.
 * The LangSmith signal interceptor must not introduce an async boundary that
 * lets `c` run before the signal handler's `b`.
 *
 * @module
 */

import test from 'ava';

import * as activities from './activities/langsmith';
import { InMemoryRunCollector, withTracingWorker } from './helpers';
import * as workflows from './workflows/langsmith';

process.env.LANGSMITH_TRACING = 'true';
process.env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';

test.serial('signalWithStart: LangSmith signal interceptor preserves workflow ordering', async (t) => {
  const collector = new InMemoryRunCollector();

  const result = await withTracingWorker({
    collector,
    options: { addTemporalRuns: true },
    activities: { a: activities.a, b: activities.b, c: activities.c },
    body: async ({ client, taskQueue }) => {
      const handle = await client.workflow.signalWithStart(workflows.SignalStartOrderingWorkflow, {
        taskQueue,
        workflowId: `signal-start-ordering-${Date.now()}`,
        signal: workflows.startSignal,
      });
      return handle.result();
    },
  });

  t.is(result, 'abc');
  t.truthy(collector.byName('HandleSignal:startSignal'), 'LangSmith signal interceptor emitted the handler run');
});
