/**
 * Line-for-line trace-tree E2E: drives one `ComprehensiveWorkflow` touching every
 * instrumented boundary and asserts the EXACT run hierarchy with `deepEqual`.
 *
 * @module
 */

import test from 'ava';
import { traceable } from 'langsmith/traceable';

import * as activities from './activities/comprehensive';
import { InMemoryRunCollector, dumpTraces, withTracingWorker } from './helpers';
import { comprehensiveNexusServiceHandler } from './stubs/nexus';
import {
  COMPREHENSIVE_NEXUS_ENDPOINT,
  ComprehensiveWorkflow,
  completeSignal,
  comprehensiveQuery,
  comprehensiveSignal,
  comprehensiveUpdate,
} from './workflows/comprehensive';

process.env.LANGSMITH_TRACING = 'true';
// Keep langsmith callbacks synchronous so a stray run fails fast instead of blocking teardown.
process.env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';

const COMPREHENSIVE_ACTIVITIES = {
  comprehensiveActivity: activities.comprehensiveActivity,
  comprehensiveLocalActivity: activities.comprehensiveLocalActivity,
  notifyReady: activities.notifyReady,
};

const WORKFLOWS_PATH = require.resolve('./workflows/comprehensive');

/** Drive one full scenario under a client-side `user_pipeline` root, issuing inbound calls in a fixed sequence. */
async function runComprehensive(addTemporalRuns: boolean): Promise<InMemoryRunCollector> {
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: { addTemporalRuns },
    activities: COMPREHENSIVE_ACTIVITIES,
    workerOptions: {
      workflowsPath: WORKFLOWS_PATH,
      nexusServices: [comprehensiveNexusServiceHandler],
    },
    body: async ({ client, taskQueue, env }) => {
      await env.createNexusEndpoint(COMPREHENSIVE_NEXUS_ENDPOINT, taskQueue);

      const ready = activities.resetReady();
      const pipeline = traceable(
        async () => {
          const handle = await client.workflow.start(ComprehensiveWorkflow, {
            taskQueue,
            workflowId: `comprehensive-${addTemporalRuns}-${Date.now()}`,
            args: [0],
          });

          // Wait until the workflow is blocked on handler calls, so the tree order is deterministic.
          await ready;

          const wrap = { client: collector.asClient(), tracingEnabled: true };

          await handle.query(comprehensiveQuery, 'q1');
          await traceable(async () => handle.query(comprehensiveQuery, 'q2'), { name: 'user_query_wrap', ...wrap })();

          await handle.signal(comprehensiveSignal, 's1');
          await traceable(async () => handle.signal(comprehensiveSignal, 's2'), {
            name: 'user_signal_wrap',
            ...wrap,
          })();

          await handle.executeUpdate(comprehensiveUpdate, { args: ['u1'] });
          await traceable(async () => handle.executeUpdate(comprehensiveUpdate, { args: ['u2'] }), {
            name: 'user_update_wrap',
            ...wrap,
          })();

          await handle.signal(completeSignal);
          await handle.result();
        },
        { name: 'user_pipeline', client: collector.asClient(), tracingEnabled: true }
      );
      await pipeline();
    },
  });
  return collector;
}

/** addTemporalRuns: true — Temporal-operation runs interleave with the user `traceable` runs. */
const EXPECTED_TRUE: string[] = [
  'user_pipeline',
  '  StartWorkflow:ComprehensiveWorkflow',
  '  RunWorkflow:ComprehensiveWorkflow',
  '    StartActivity:comprehensiveActivity',
  '    RunActivity:comprehensiveActivity',
  '      comprehensive_activity',
  '        comprehensive_activity_inner',
  '    user_wrap_activity',
  '      StartActivity:comprehensiveActivity',
  '      RunActivity:comprehensiveActivity',
  '        comprehensive_activity',
  '          comprehensive_activity_inner',
  '    StartActivity:comprehensiveLocalActivity',
  '    RunActivity:comprehensiveLocalActivity',
  '    StartChildWorkflow:ComprehensiveChildWorkflow',
  '    RunWorkflow:ComprehensiveChildWorkflow',
  '      StartActivity:comprehensiveActivity',
  '      RunActivity:comprehensiveActivity',
  '        comprehensive_activity',
  '          comprehensive_activity_inner',
  '    user_wrap_child',
  '      StartChildWorkflow:ComprehensiveChildWorkflow',
  '      RunWorkflow:ComprehensiveChildWorkflow',
  '        StartActivity:comprehensiveActivity',
  '        RunActivity:comprehensiveActivity',
  '          comprehensive_activity',
  '            comprehensive_activity_inner',
  '    StartChildWorkflow:ComprehensiveReceiverWorkflow',
  '    SignalChildWorkflow:signal',
  '      HandleSignal:signal',
  '    RunWorkflow:ComprehensiveReceiverWorkflow',
  '    StartNexusOperation:comprehensiveNexusService/greet',
  '    RunStartNexusOperationHandler:comprehensiveNexusService/greet',
  '      nexus_inner_call',
  '    workflow_inner_call',
  '    StartActivity:notifyReady',
  '    RunActivity:notifyReady',
  '    RunWorkflow:ComprehensiveWorkflow',
  '  QueryWorkflow:query',
  '    HandleQuery:query',
  '      query_inner_call',
  '  user_query_wrap',
  '    QueryWorkflow:query',
  '      HandleQuery:query',
  '        query_inner_call',
  '  SignalWorkflow:signal',
  '    HandleSignal:signal',
  '      signal_inner_call',
  '  user_signal_wrap',
  '    SignalWorkflow:signal',
  '      HandleSignal:signal',
  '        signal_inner_call',
  '  StartWorkflowUpdate:update',
  '    ValidateUpdate:update',
  '      validator_inner_call',
  '    HandleUpdate:update',
  '      update_inner_call',
  '  user_update_wrap',
  '    StartWorkflowUpdate:update',
  '      ValidateUpdate:update',
  '        validator_inner_call',
  '      HandleUpdate:update',
  '        update_inner_call',
  '  SignalWorkflow:complete',
  '    HandleSignal:complete',
];

/** addTemporalRuns: false — only the user `traceable` runs, still parented across every boundary. */
const EXPECTED_FALSE: string[] = [
  'user_pipeline',
  '  comprehensive_activity',
  '    comprehensive_activity_inner',
  '  user_wrap_activity',
  '    comprehensive_activity',
  '      comprehensive_activity_inner',
  '  comprehensive_activity',
  '    comprehensive_activity_inner',
  '  user_wrap_child',
  '    comprehensive_activity',
  '      comprehensive_activity_inner',
  '  nexus_inner_call',
  '  workflow_inner_call',
  '  query_inner_call',
  '  user_query_wrap',
  '    query_inner_call',
  '  user_signal_wrap',
  '    signal_inner_call',
  '  signal_inner_call',
  '  validator_inner_call',
  '  update_inner_call',
  '  user_update_wrap',
  '    validator_inner_call',
  '    update_inner_call',
];

test.serial('comprehensive trace tree: addTemporalRuns=true', async (t) => {
  const collector = await runComprehensive(true);
  t.deepEqual(dumpTraces(collector.records).split('\n'), EXPECTED_TRUE);
});

test.serial('comprehensive trace tree: addTemporalRuns=false', async (t) => {
  const collector = await runComprehensive(false);
  t.deepEqual(dumpTraces(collector.records).split('\n'), EXPECTED_FALSE);
});
