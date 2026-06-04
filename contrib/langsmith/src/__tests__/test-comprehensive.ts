/**
 * The primary end-to-end test. Boots a real local Temporal server
 * (`TestWorkflowEnvironment.createLocal`) with the plugin on the client and the
 * worker, runs workflows whose activity / child-workflow bodies carry unchanged
 * native `traceable` instrumentation, captures every emitted run in an
 * {@link InMemoryRunCollector}, and asserts the **exact** run hierarchy with
 * `deepEqual` on {@link dumpTraces}.
 *
 * Two hierarchies are pinned:
 *  - Tree A (`addTemporalRuns: true`): Temporal-operation runs (`StartWorkflow:`,
 *    `RunActivity:`, …) interleave with the user's `traceable` runs.
 *  - Tree B (`addTemporalRuns: false`): only the user's `traceable` runs appear,
 *    yet they still nest correctly because the trace context propagates across
 *    every boundary.
 *
 * @module
 */

// Force LangSmith's own tracing gate on for this process so the user-side
// `traceable` roots emit deterministically regardless of ambient env. (The
// plugin-level kill switch is tested separately in test-env.ts.)
process.env.LANGSMITH_TRACING = 'true';

import test from 'ava';
import { traceable } from 'langsmith/traceable';

import * as activities from './activities/langsmith';
import { InMemoryRunCollector, dumpTraces, withTracingWorker } from './helpers';
import * as workflows from './workflows/langsmith';

const ALL_ACTIVITIES = {
  simpleActivity: activities.simpleActivity,
  plainActivity: activities.plainActivity,
  traceableActivity: activities.traceableActivity,
  nestedTraceableActivity: activities.nestedTraceableActivity,
  failingActivity: activities.failingActivity,
  benignFailingActivity: activities.benignFailingActivity,
};

/** Tree A — addTemporalRuns: true. */
const TREE_A = [
  'user_pipeline',
  '  StartWorkflow:ComprehensiveWorkflow',
  '  RunWorkflow:ComprehensiveWorkflow',
  '    StartActivity:nestedTraceableActivity',
  '    RunActivity:nestedTraceableActivity',
  '      nested_traceable_activity',
  '        outer_chain',
  '          inner_llm_call',
  '    StartChildWorkflow:TraceableActivityWorkflow',
  '    RunWorkflow:TraceableActivityWorkflow',
  '      StartActivity:traceableActivity',
  '      RunActivity:traceableActivity',
  '        traceable_activity',
  '          inner_llm_call',
].join('\n');

/** Tree B — addTemporalRuns: false (only user `traceable` runs, still parented). */
const TREE_B = [
  'user_pipeline',
  '  nested_traceable_activity',
  '    outer_chain',
  '      inner_llm_call',
  '  traceable_activity',
  '    inner_llm_call',
].join('\n');

/** Basic single-activity workflow with addTemporalRuns on — two roots, no ambient. */
const SIMPLE_TREE = [
  'StartWorkflow:SimpleWorkflow',
  'RunWorkflow:SimpleWorkflow',
  '  StartActivity:simpleActivity',
  '  RunActivity:simpleActivity',
].join('\n');

/**
 * Workflow-body `traceable` with addTemporalRuns on. The `workflow_inner_call`
 * run is created *inside the V8 isolate* (not an activity), so it can only nest
 * under `RunWorkflow:` if the plugin's installed LangSmith context provider
 * resolved the workflow run as its parent.
 */
const WORKFLOW_BODY_TREE_A = [
  'user_pipeline',
  '  StartWorkflow:WorkflowBodyTraceableWorkflow',
  '  RunWorkflow:WorkflowBodyTraceableWorkflow',
  '    workflow_inner_call',
].join('\n');

/** Workflow-body `traceable` with addTemporalRuns off — still parented via the propagated context. */
const WORKFLOW_BODY_TREE_B = ['user_pipeline', '  workflow_inner_call'].join('\n');

/** Local-activity workflow with addTemporalRuns on — exercises the `scheduleLocalActivity` outbound path. */
const LOCAL_ACTIVITY_TREE = [
  'StartWorkflow:LocalActivityWorkflow',
  'RunWorkflow:LocalActivityWorkflow',
  '  StartActivity:simpleActivity',
  '  RunActivity:simpleActivity',
].join('\n');

test('comprehensive run hierarchy: emits the full Temporal-run hierarchy under a user root (addTemporalRuns: true)', async (t) => {
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: { addTemporalRuns: true },
    activities: ALL_ACTIVITIES,
    body: async ({ client, taskQueue }) => {
      const pipeline = traceable(
        async () =>
          client.workflow.execute(workflows.ComprehensiveWorkflow, {
            taskQueue,
            workflowId: `comprehensive-true-${Date.now()}`,
            args: ['hello'],
          }),
        { name: 'user_pipeline', client: collector.asClient(), tracingEnabled: true },
      );
      await pipeline();
    },
  });
  t.deepEqual(dumpTraces(collector.records), TREE_A);
});

test('comprehensive run hierarchy: emits only the traceable hierarchy but still parents it (addTemporalRuns: false)', async (t) => {
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: { addTemporalRuns: false },
    activities: ALL_ACTIVITIES,
    body: async ({ client, taskQueue }) => {
      const pipeline = traceable(
        async () =>
          client.workflow.execute(workflows.ComprehensiveWorkflow, {
            taskQueue,
            workflowId: `comprehensive-false-${Date.now()}`,
            args: ['hello'],
          }),
        { name: 'user_pipeline', client: collector.asClient(), tracingEnabled: true },
      );
      await pipeline();
    },
  });
  t.deepEqual(dumpTraces(collector.records), TREE_B);
});

test('comprehensive run hierarchy: emits the basic SimpleWorkflow tree with no ambient (two roots)', async (t) => {
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: { addTemporalRuns: true },
    activities: ALL_ACTIVITIES,
    body: async ({ client, taskQueue }) => {
      await client.workflow.execute(workflows.SimpleWorkflow, {
        taskQueue,
        workflowId: `simple-${Date.now()}`,
        args: ['hi'],
      });
    },
  });
  t.deepEqual(dumpTraces(collector.records), SIMPLE_TREE);
});

test('comprehensive run hierarchy: emits the local-activity hierarchy (scheduleLocalActivity outbound path)', async (t) => {
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: { addTemporalRuns: true },
    activities: ALL_ACTIVITIES,
    body: async ({ client, taskQueue }) => {
      await client.workflow.execute(workflows.LocalActivityWorkflow, {
        taskQueue,
        workflowId: `local-activity-${Date.now()}`,
        args: ['hi'],
      });
    },
  });
  t.deepEqual(dumpTraces(collector.records), LOCAL_ACTIVITY_TREE);
});

/**
 * The in-isolate path: a native `traceable` invoked **inside a workflow body**.
 * Unlike the activity-body cases above (which run in the real Node worker process
 * where LangSmith's own `AsyncLocalStorage` works), this exercises the plugin's
 * isolate-safe context provider — `WorkflowContextManager.run`/`stack` installed
 * via `AsyncLocalStorageProviderSingleton`. Without it, `getCurrentRunTree()`
 * inside the isolate returns `undefined` and the run would not nest. This is the
 * subsystem behind the "works unchanged inside workflows" claim.
 */
test('workflow-body traceable nests via the isolate context provider: nests the workflow-body run under RunWorkflow (addTemporalRuns: true)', async (t) => {
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: { addTemporalRuns: true },
    activities: ALL_ACTIVITIES,
    body: async ({ client, taskQueue }) => {
      const pipeline = traceable(
        async () =>
          client.workflow.execute(workflows.WorkflowBodyTraceableWorkflow, {
            taskQueue,
            workflowId: `wf-body-true-${Date.now()}`,
            args: ['hello'],
          }),
        { name: 'user_pipeline', client: collector.asClient(), tracingEnabled: true },
      );
      await pipeline();
    },
  });
  t.deepEqual(dumpTraces(collector.records), WORKFLOW_BODY_TREE_A);
});

test('workflow-body traceable nests via the isolate context provider: nests the workflow-body run under the propagated parent (addTemporalRuns: false)', async (t) => {
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: { addTemporalRuns: false },
    activities: ALL_ACTIVITIES,
    body: async ({ client, taskQueue }) => {
      const pipeline = traceable(
        async () =>
          client.workflow.execute(workflows.WorkflowBodyTraceableWorkflow, {
            taskQueue,
            workflowId: `wf-body-false-${Date.now()}`,
            args: ['hello'],
          }),
        { name: 'user_pipeline', client: collector.asClient(), tracingEnabled: true },
      );
      await pipeline();
    },
  });
  t.deepEqual(dumpTraces(collector.records), WORKFLOW_BODY_TREE_B);
});

test('plugin options are carried onto emitted runs: applies projectName, defaultTags, and (scrubbed) defaultMetadata', async (t) => {
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: {
      addTemporalRuns: true,
      projectName: 'my-project',
      defaultTags: ['env:test'],
      // The api_key entry must be scrubbed before it reaches the backend.
      defaultMetadata: { team: 'platform', api_key: 'should-be-removed' },
    },
    activities: ALL_ACTIVITIES,
    body: async ({ client, taskQueue }) => {
      await client.workflow.execute(workflows.SimpleWorkflow, {
        taskQueue,
        workflowId: `options-${Date.now()}`,
        args: ['hi'],
      });
    },
  });

  const runWorkflow = collector.byName('RunWorkflow:SimpleWorkflow');
  t.is(runWorkflow?.project_name, 'my-project');
  t.deepEqual(runWorkflow?.tags, ['env:test']);
  const metadata = runWorkflow?.extra?.metadata as Record<string, unknown> | undefined;
  t.deepEqual(metadata, { team: 'platform' });
  t.false('api_key' in (metadata ?? {}));
});
