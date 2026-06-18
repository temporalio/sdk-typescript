/**
 * Run-hierarchy edge cases the comprehensive test cannot cover: no-ambient-run roots,
 * the root workflow-body `traceable` `crypto` regression, and per-field plugin options.
 *
 * @module
 */

import test from 'ava';

import * as activities from './activities/langsmith';
import { InMemoryRunCollector, SIMPLE_TREE, dumpTraces, withTracingWorker } from './helpers';
import * as workflows from './workflows/langsmith';

process.env.LANGSMITH_TRACING = 'true';

const ALL_ACTIVITIES = {
  simpleActivity: activities.simpleActivity,
};

/** Root workflow-body `traceable`, no propagated parent — just the user run, no placeholder root. */
const WORKFLOW_BODY_ROOT_TREE = ['workflow_inner_call'].join('\n');

test('emits the basic SimpleWorkflow tree with no ambient (two roots)', async (t) => {
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

// No propagated parent: the placeholder root keeps LangSmith off its `crypto`-minting branch (absent in the isolate).
test('root workflow-body traceable (no propagated parent) does not crash and emits just the user run', async (t) => {
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: { addTemporalRuns: false },
    activities: ALL_ACTIVITIES,
    body: async ({ client, taskQueue }) => {
      await client.workflow.execute(workflows.WorkflowBodyTraceableWorkflow, {
        taskQueue,
        workflowId: `wf-body-root-${Date.now()}`,
        args: ['hello'],
      });
    },
  });
  t.deepEqual(dumpTraces(collector.records), WORKFLOW_BODY_ROOT_TREE);
});

test('plugin options are carried onto emitted runs: applies projectName, tags, and (scrubbed) metadata', async (t) => {
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: {
      addTemporalRuns: true,
      projectName: 'my-project',
      tags: ['env:test'],
      // The api_key entry must be scrubbed before it reaches the backend.
      metadata: { team: 'platform', api_key: 'should-be-removed' },
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

test('emitter-side activity run scrubs credential-looking metadata (path that never hits serializeRun)', async (t) => {
  const collector = new InMemoryRunCollector();
  await withTracingWorker({
    collector,
    options: {
      addTemporalRuns: true,
      metadata: { team: 'platform', api_key: 'should-be-removed' },
    },
    activities: ALL_ACTIVITIES,
    body: async ({ client, taskQueue }) => {
      await client.workflow.execute(workflows.SimpleWorkflow, {
        taskQueue,
        workflowId: `activity-scrub-${Date.now()}`,
        args: ['hi'],
      });
    },
  });

  const runActivity = collector.byName('RunActivity:simpleActivity');
  const metadata = runActivity?.extra?.metadata as Record<string, unknown> | undefined;
  t.deepEqual(metadata, { team: 'platform' });
  t.false('api_key' in (metadata ?? {}));
});
