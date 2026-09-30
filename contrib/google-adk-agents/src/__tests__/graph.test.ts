/**
 * E2E tests for ADK 2.0's workflow (graph) runtime inside a Temporal Workflow:
 * `activityNode`, routing, fan-out/join, agent nodes, node timeouts and retries,
 * failure propagation, node-callback plugins, `App` roots and compactors.
 */

import test from 'ava';
import { ActivityFailure, ApplicationFailure, TimeoutFailure } from '@temporalio/common';
import { Worker } from '@temporalio/worker';

import { GoogleAdkPlugin } from '../index';
import { activityNode } from '../workflow';
import {
  countScheduledActivities,
  findInCauseChain,
  getScheduledActivitySummaries,
  REUSE_V8_CONTEXT,
  setupTestEnv,
  uid,
  withWorker,
  workflowsPath,
} from './helpers';
import * as activities from './test-activities';
import { graphTestProvider } from './test-models';
import {
  appRoot,
  compactedAgent,
  graphActivityFailure,
  graphAgentNodeModelFailure,
  graphAgentTaskNode,
  graphDottedActivity,
  graphFanOutJoin,
  graphPluginNodeCallbacks,
  graphRetriedAgentNode,
  graphRetry,
  graphRouting,
  graphSequential,
  graphTimeout,
  graphTimeoutRetry,
  graphVoidOutput,
  twoAgentsOneFailureSwallowed,
} from './graph-workflows';

const getEnv = setupTestEnv(test);

function makePlugin(): GoogleAdkPlugin {
  return new GoogleAdkPlugin({ modelProvider: graphTestProvider() });
}

async function history(workflowId: string) {
  const env = getEnv();
  const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
  return events ?? [];
}

test.serial('sequential Activity nodes pass output downstream, one Activity each', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-seq');
  const workflowId = uid('wf-graph-seq');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    env.client.workflow.execute(graphSequential, { taskQueue, workflowId, args: ['hello'] })
  );
  t.is(result.output, 'data-for-hello summarized');
  const events = await history(workflowId);
  t.is(countScheduledActivities(events, 'fetchData'), 1);
  t.is(countScheduledActivities(events, 'summarize'), 1);
  t.deepEqual(activities.executionsFor(workflowId), ['fetchData:hello', 'summarize:data-for-hello']);
});

test.serial('a route from a node runs only the matching branch Activity', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-route');
  const approved = uid('wf-graph-route-approve');
  const other = uid('wf-graph-route-other');
  await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
    t.is(
      (await env.client.workflow.execute(graphRouting, { taskQueue, workflowId: approved, args: ['approve'] })).output,
      'approved'
    );
    t.is(
      (await env.client.workflow.execute(graphRouting, { taskQueue, workflowId: other, args: ['anything'] })).output,
      'rejected'
    );
  });
  const approvedEvents = await history(approved);
  t.is(countScheduledActivities(approvedEvents, 'approveActivity'), 1);
  t.is(countScheduledActivities(approvedEvents, 'rejectActivity'), 0);
  const otherEvents = await history(other);
  t.is(countScheduledActivities(otherEvents, 'approveActivity'), 0);
  t.is(countScheduledActivities(otherEvents, 'rejectActivity'), 1);
});

test.serial('fan-out Activity nodes join, keyed by node name', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-join');
  const workflowId = uid('wf-graph-join');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    env.client.workflow.execute(graphFanOutJoin, { taskQueue, workflowId })
  );
  t.deepEqual(result.output, { enrich_a: 'enriched-alpha', enrich_b: 'enriched-beta' });
  const events = await history(workflowId);
  t.is(countScheduledActivities(events, 'enrichItem'), 2);
  // Both nodes run the one `enrichItem` Activity, so the summary names the node.
  t.deepEqual(getScheduledActivitySummaries(events, 'enrichItem').sort(), ['adk.node enrich_a', 'adk.node enrich_b']);
});

test.serial('an Activity node returning nothing completes and its successor runs', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-void');
  const workflowId = uid('wf-graph-void');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    env.client.workflow.execute(graphVoidOutput, { taskQueue, workflowId })
  );
  // ADK's `waitForOutput` parks exactly this node forever, which is why
  // `activityNode` does not expose it; fan in with a `JoinNode` instead.
  t.is(result.output, 'after');
  t.is(countScheduledActivities(await history(workflowId), 'voidActivity'), 1);
});

test('activityNode refuses a node name carrying ADK path separator', (t) => {
  // ADK splits a node path on '.', so a dotted name is unrecognisable on resume.
  const err = t.throws(() => activityNode({ name: 'payments.charge' }), { instanceOf: ApplicationFailure });
  t.is(err?.type, 'GoogleAdkActivityNodeName');
  t.is(err?.nonRetryable, true);
  t.true(err?.message.includes('payments_charge'), err?.message);
  t.notThrows(() => activityNode({ name: 'payments.charge', nodeName: 'payments_charge' }));
});

test.serial('a dotted Activity type runs under a path-safe node name', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-dotted');
  const workflowId = uid('wf-graph-dotted');
  const dotted = { ...activities, 'payments.charge': async () => 'charged' };
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities: dotted }, () =>
    env.client.workflow.execute(graphDottedActivity, { taskQueue, workflowId })
  );
  t.is(result.output, 'charged');
  const events = await history(workflowId);
  t.is(countScheduledActivities(events, 'payments.charge'), 1);
  t.deepEqual(getScheduledActivitySummaries(events, 'payments.charge'), ['adk.node payments_charge']);
});

test.serial('an LlmAgent node in task mode reports its finish_task result as the node output', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-task');
  const workflowId = uid('wf-graph-task');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    env.client.workflow.execute(graphAgentTaskNode, { taskQueue, workflowId, args: ['do it'] })
  );
  t.deepEqual(result.output, { result: 'task-done' });
  t.is(countScheduledActivities(await history(workflowId), 'adk-invokeModel'), 1);
});

test.serial('a node timeout waits for the cancelled Activity before failing the Workflow', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-timeout');
  const workflowId = uid('wf-graph-timeout');
  const err = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    t.throwsAsync(env.client.workflow.execute(graphTimeout, { taskQueue, workflowId }))
  );
  t.is((err as Error).name, 'WorkflowFailedError');
  // ADK's plain `NodeTimeoutError` is converted, so the execution FAILS instead of
  // retrying the Workflow Task forever.
  const failure = findInCauseChain(err, ApplicationFailure);
  t.is(failure?.type, 'GoogleAdkNodeTimeoutError');
  t.is(failure?.nonRetryable, true);
  t.is(findInCauseChain(err, TimeoutFailure), undefined);
  // The deadline cancelled the Activity and the node waited for that cancellation to
  // complete, rather than leaving it running behind a Workflow that had moved on.
  const events = await history(workflowId);
  const cancelled = events.findIndex((e) => e.activityTaskCanceledEventAttributes != null);
  const failed = events.findIndex((e) => e.workflowExecutionFailedEventAttributes != null);
  t.true(cancelled !== -1, 'expected an ActivityTaskCanceled event');
  t.true(failed !== -1, 'expected a WorkflowExecutionFailed event');
  t.true(cancelled < failed, `ActivityTaskCanceled (${cancelled}) must precede the failure (${failed})`);
});

test.serial('an ADK retry after a node timeout does not overlap the cancelled Activity', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-timeout-retry');
  const workflowId = uid('wf-graph-timeout-retry');
  const err = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    t.throwsAsync(env.client.workflow.execute(graphTimeoutRetry, { taskQueue, workflowId }))
  );
  t.is(findInCauseChain(err, ApplicationFailure)?.type, 'GoogleAdkNodeTimeoutError');
  const events = await history(workflowId);
  const at = (match: (e: (typeof events)[number]) => boolean) =>
    events.map((e, i) => (match(e) ? i : -1)).filter((i) => i !== -1);
  const scheduled = at((e) => e.activityTaskScheduledEventAttributes != null);
  const cancelled = at((e) => e.activityTaskCanceledEventAttributes != null);
  t.is(scheduled.length, 2, 'ADK retried the timed-out node once');
  t.is(cancelled.length, 2, 'both attempts cancelled their Activity');
  t.true(
    scheduled[1]! > cancelled[0]!,
    `the retry (${scheduled[1]}) must be scheduled after the first cancellation completed (${cancelled[0]})`
  );
});

test.serial('ADK node retries with jitter re-run a failed Activity and replay deterministically', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-retry');
  const workflowId = uid('wf-graph-retry');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    env.client.workflow.execute(graphRetry, { taskQueue, workflowId, args: [1] })
  );
  t.is(result.output, 'ok-after-2');
  const events = await history(workflowId);
  t.is(countScheduledActivities(events, 'flakyActivity'), 3);
  // The backoff between attempts is a durable timer whose jitter came from the
  // Workflow's seeded `Math.random()`; the cache-disabled worker already replayed
  // it on every task, and a full replay of the history must agree too.
  await Worker.runReplayHistory(
    { workflowsPath, reuseV8Context: REUSE_V8_CONTEXT, plugins: [makePlugin()] },
    await env.client.workflow.getHandle(workflowId).fetchHistory()
  );
});

test.serial('a permanently failing Activity node fails the Workflow through its ActivityFailure', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-fail');
  const workflowId = uid('wf-graph-fail');
  const err = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    t.throwsAsync(env.client.workflow.execute(graphActivityFailure, { taskQueue, workflowId }))
  );
  t.is((err as Error).name, 'WorkflowFailedError');
  t.not(findInCauseChain(err, ActivityFailure), undefined);
  t.is(findInCauseChain(err, ApplicationFailure)?.type, 'TestPermanentFailure');
});

test.serial('an agent node whose model call fails surfaces the recorded model failure', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-agent-fail');
  const workflowId = uid('wf-graph-agent-fail');
  const err = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    t.throwsAsync(
      env.client.workflow.execute(graphAgentNodeModelFailure, { taskQueue, workflowId, args: ['boom', false] })
    )
  );
  t.is((err as Error).name, 'WorkflowFailedError');
  // ADK reports the absorbed model error as a `NodeReportedError`; the plugin raises
  // the recorded `ActivityFailure` instead, keeping the model failure's status.
  t.not(findInCauseChain(err, ActivityFailure), undefined);
  t.is(findInCauseChain(err, ApplicationFailure)?.type, 'GoogleAdkModelError.400');
});

test.serial('an agent node whose retry succeeds does not fail on the attempt ADK recovered', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-agent-retry');
  const workflowId = uid('wf-graph-agent-retry');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    env.client.workflow.execute(graphRetriedAgentNode, { taskQueue, workflowId })
  );
  // ADK absorbed the first model error into an event, retried the node, and got its
  // answer, so the run finished normally and nothing is left to raise.
  t.is(result.text, 'recovered-on-attempt-2');
  t.is(countScheduledActivities(await history(workflowId), 'adk-invokeModel'), 2);
});

test.serial('one agent succeeding does not clear another agent absorbed failure', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-seq-agents');
  const err = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    t.throwsAsync(
      env.client.workflow.execute(twoAgentsOneFailureSwallowed, {
        taskQueue,
        workflowId: uid('wf-graph-seq-agents'),
      })
    )
  );
  // The second agent answering says nothing about the first agent's failure, which no
  // callback handled, so the Workflow still ends on it.
  t.is(findInCauseChain(err, ApplicationFailure)?.type, 'GoogleAdkModelError.400');
});

test.serial('an agent node recovered by onModelErrorCallback completes', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-agent-recover');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    env.client.workflow.execute(graphAgentNodeModelFailure, {
      taskQueue,
      workflowId: uid('wf-graph-agent-recover'),
      args: ['boom', true],
    })
  );
  t.is(result.text, 'recovered');
});

test.serial('plugins observe beforeNodeCallback / afterNodeCallback around an Activity node', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-callbacks');
  const seen = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    env.client.workflow.execute(graphPluginNodeCallbacks, { taskQueue, workflowId: uid('wf-graph-callbacks') })
  );
  // The `Workflow` root is itself a node, so ADK reports it around its children.
  t.deepEqual(seen, ['before:callbacks_graph', 'before:fetchData', 'after:fetchData', 'after:callbacks_graph']);
});

test.serial('an App root with resumability enabled runs through InMemoryRunner', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-app');
  const text = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(appRoot, { taskQueue, workflowId: uid('wf-graph-app'), args: ['hi'] })
  );
  t.is(text, 'fake-response:fake-model');
});

test.serial('a truncating context compactor drops old events across turns in one session', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-graph-compact');
  const texts = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(compactedAgent, { taskQueue, workflowId: uid('wf-graph-compact'), args: [3] })
  );
  // Each turn adds two events; the compactor (threshold 2) truncates, so the history the
  // model receives stops growing instead of reaching 5 on the third turn.
  t.deepEqual(texts, ['contents:1', 'contents:2', 'contents:2']);
});
