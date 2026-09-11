/**
 * E2E tests for ADK 2.0 dynamic nodes (`ctx.runNode` from a node body) and
 * workflow-as-tool inside a Temporal Workflow.
 */

import test from 'ava';

import { GoogleAdkPlugin } from '../index';
import { countScheduledActivities, setupTestEnv, uid, withWorker } from './helpers';
import * as activities from './test-activities';
import { graphTestProvider } from './test-models';
import { dynamicGather, dynamicLoop, workflowAsTool } from './graph-workflows';

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
