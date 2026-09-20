/**
 * E2E tests for ADK 2.0 dynamic nodes (`ctx.runNode` from a node body) and
 * workflow-as-tool inside a Temporal Workflow.
 */

import test from 'ava';
import { ActivityFailure, ApplicationFailure, CancelledFailure } from '@temporalio/common';

import { GoogleAdkPlugin } from '../index';
import {
  countScheduledActivities,
  findInCauseChain,
  setupTestEnv,
  uid,
  waitForScheduledActivities,
  withWorker,
} from './helpers';
import * as activities from './test-activities';
import { graphTestProvider } from './test-models';
import {
  dynamicActivityFailure,
  dynamicAgentModelFailure,
  dynamicCancellation,
  dynamicGather,
  dynamicLoop,
  workflowAsTool,
} from './graph-workflows';

const getEnv = setupTestEnv(test);

function makePlugin(): GoogleAdkPlugin {
  return new GoogleAdkPlugin({ modelProvider: graphTestProvider() });
}

test.serial('a dynamic node runs an Activity node in a loop', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-dyn-loop');
  const workflowId = uid('wf-dyn-loop');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    env.client.workflow.execute(dynamicLoop, { taskQueue, workflowId, args: [3] })
  );
  t.deepEqual(result.output, ['enriched-0', 'enriched-1', 'enriched-2']);
  const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
  t.is(countScheduledActivities(events ?? [], 'enrichNumber'), 3);
});

test.serial('a dynamic node fans out Activity nodes with Promise.all', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-dyn-gather');
  const workflowId = uid('wf-dyn-gather');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    env.client.workflow.execute(dynamicGather, { taskQueue, workflowId })
  );
  t.deepEqual(result.output, ['enriched-1', 'enriched-2']);
  const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
  // Both Activities were scheduled before either completed: concurrent, not sequential.
  const scheduled = (events ?? []).map((e, i) => ({ e, i })).filter(({ e }) => e.activityTaskScheduledEventAttributes);
  const firstCompleted = (events ?? []).findIndex((e) => e.activityTaskCompletedEventAttributes);
  t.is(scheduled.length, 2);
  t.true(scheduled.every(({ i }) => i < firstCompleted));
});

test.serial('a dynamic node Activity failure keeps its ActivityFailure cause chain', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-dyn-fail');
  const err = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    t.throwsAsync(env.client.workflow.execute(dynamicActivityFailure, { taskQueue, workflowId: uid('wf-dyn-fail') }))
  );
  // ADK wraps a dynamic child's error in a `DynamicNodeFailError`, which carries the
  // original on `.error` rather than on `.cause`; the plugin raises the Temporal failure
  // instead, so the chain matches what a static Activity node produces.
  t.not(findInCauseChain(err, ActivityFailure), undefined);
  t.is(findInCauseChain(err, ApplicationFailure)?.type, 'TestPermanentFailure');
});

test.serial('a dynamic agent node whose model call fails keeps the model failure chain', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-dyn-agent-fail');
  const err = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    t.throwsAsync(
      env.client.workflow.execute(dynamicAgentModelFailure, { taskQueue, workflowId: uid('wf-dyn-agent-fail') })
    )
  );
  // The recording sits under a `NodeReportedError` under a `DynamicNodeFailError`, so
  // both carriers have to be unwrapped before the frame's recording is the answer.
  t.not(findInCauseChain(err, ActivityFailure), undefined);
  t.is(findInCauseChain(err, ApplicationFailure)?.type, 'GoogleAdkModelError.400');
});

test.serial('cancelling a Workflow running a dynamic node Activity ends it CANCELLED', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-dyn-cancel');
  const workflowId = uid('wf-dyn-cancel');
  await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
    const handle = await env.client.workflow.start(dynamicCancellation, { taskQueue, workflowId });
    await waitForScheduledActivities(env, workflowId, 'slowActivity');
    await handle.cancel();
    const err = await t.throwsAsync(handle.result());
    // The `DynamicNodeFailError` wrapping the cancelled Activity must not become an
    // `ApplicationFailure`: that would end the execution FAILED instead of CANCELLED.
    t.not(findInCauseChain(err, CancelledFailure), undefined);
    t.is((await handle.describe()).status.name, 'CANCELLED');
  });
});

test.serial('a Workflow with a Zod inputSchema is a tool with real parameters', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-dyn-tool-zod');
  const workflowId = uid('wf-dyn-tool-zod');
  const { text } = await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, () =>
    env.client.workflow.execute(workflowAsTool, { taskQueue, workflowId, args: ['zod'] })
  );
  // `ToolCallingLlm` reports the tool result it was fed and the declarations it saw.
  t.true(text.includes('tool=enrich_flow'), text);
  t.true(text.includes('enriched-7'), text);
  t.true(text.includes('enrich_flow(value)'), text);
  const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
  t.is(countScheduledActivities(events ?? [], 'enrichNumber'), 1);
});

test.serial('a Workflow with a genai Schema is a tool taking a single request string', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-dyn-tool-genai');
  await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
    // A string-typed genai schema: ADK advertises `{request: string}` and hands the
    // string to the graph, which accepts it.
    const asString = await env.client.workflow.execute(workflowAsTool, {
      taskQueue,
      workflowId: uid('wf-dyn-tool-genai-string'),
      args: ['genai-string'],
    });
    t.true(asString.text.includes('enriched-7'), asString.text);
    t.true(asString.text.includes('enrich_flow(request)'), asString.text);
    // An object-typed genai schema cannot be satisfied through that single string:
    // the graph produces no output, and since a `NodeTool` is long-running, a
    // missing result defers the tool response — the turn ends with nothing. Use a
    // Zod object schema for real parameters.
    const asObject = await env.client.workflow.execute(workflowAsTool, {
      taskQueue,
      workflowId: uid('wf-dyn-tool-genai-object'),
      args: ['genai-object'],
    });
    t.is(asObject.text, '');
    t.is(asObject.output, undefined);
    t.is(asObject.errorMessage, undefined);
  });
});
