/**
 * Durable human-in-the-loop with ADK 2.0 inside a Temporal Workflow.
 *
 * The ADK agent loop runs in the Workflow body, so a pause is ordinary Workflow
 * code: a Query exposes what is pending, an Update takes the human's answer, and
 * the next `runAsync` turn carries it as a user-authored function response. The
 * fixtures in `graph-workflows.ts` implement that loop with the plugin's
 * `pendingHitlRequests` / `hitlInputResponse` / `hitlConfirmationResponse`; the
 * original `LongRunningFunctionTool` test (a tool body awaiting a Signal/Update
 * directly) is kept as the simplest form.
 */

import test from 'ava';
import { createEvent } from '@google/adk';
import { ApplicationFailure } from '@temporalio/common';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';

import { GoogleAdkPlugin } from '../index';
import { hitlConfirmationResponse, hitlInputResponse, pendingHitlRequests, type HitlRequest } from '../workflow';
import { mockMCPToolset } from '../testing';
import {
  countScheduledActivities,
  echoDef,
  findInCauseChain,
  REUSE_V8_CONTEXT,
  setupTestEnv,
  uid,
  withWorker,
  workflowsPath,
} from './helpers';
import * as activities from './test-activities';
import { graphTestProvider } from './test-models';
import {
  answerAsTextUpdate,
  dynamicResume,
  hitlAgentRequestInput,
  hitlConfirmActivityTool,
  hitlConfirmMcpTool,
  hitlDefaultInterruptId,
  hitlDynamicGateTool,
  hitlInputNode,
  hitlSecurityPlugin,
  hitlTwoPending,
  pendingHitlQuery,
  plainTextTurnUpdate,
  respondHitlUpdate,
} from './graph-workflows';
import { approveSignal, approveUpdate, hitlWorkflow } from './workflows';

const getEnv = setupTestEnv(test);

function makePlugin(): GoogleAdkPlugin {
  return new GoogleAdkPlugin({
    modelProvider: graphTestProvider(),
    mcpToolsets: { testServer: mockMCPToolset([echoDef]) },
  });
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A started Workflow's handle, typed off the test environment's client. */
type Handle = Awaited<ReturnType<TestWorkflowEnvironment['client']['workflow']['start']>>;

/** Polls the pending-requests Query until it reports `count` pauses with the expected ids (if given). */
async function waitForPending(handle: Handle, count: number, ids?: string[]): Promise<HitlRequest[]> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const pending = await handle.query(pendingHitlQuery);
    if (pending.length === count && (!ids || ids.every((id) => pending.some((r) => r.interruptId === id)))) {
      return pending;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} pending HITL request(s); have ${JSON.stringify(pending)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function scheduledCount(workflowId: string, activityType: string): Promise<number> {
  const { events } = await getEnv().client.workflow.getHandle(workflowId).fetchHistory();
  return countScheduledActivities(events ?? [], activityType);
}

// HITL long-running tool (E2E)
test.serial('longRunningToolAwaitsSignal', async (t) => {
  const env = getEnv();
  // --- Signal variant ---
  const tq1 = uid('adk-hitl-sig');
  await withWorker(env, { taskQueue: tq1, plugins: [new GoogleAdkPlugin()] }, async () => {
    const handle = await env.client.workflow.start(hitlWorkflow, {
      taskQueue: tq1,
      workflowId: uid('wf-hitl-sig'),
    });
    await handle.signal(approveSignal, 'approved-via-signal');
    t.is(await handle.result(), 'approved-via-signal');
  });

  // --- Update variant (same handler, request/response) ---
  const tq2 = uid('adk-hitl-upd');
  await withWorker(env, { taskQueue: tq2, plugins: [new GoogleAdkPlugin()] }, async () => {
    const handle = await env.client.workflow.start(hitlWorkflow, {
      taskQueue: tq2,
      workflowId: uid('wf-hitl-upd'),
    });
    const updateResult = await handle.executeUpdate(approveUpdate, {
      args: ['approved-via-update'],
    });
    t.is(updateResult, 'approved-via-update');
    t.is(await handle.result(), 'approved-via-update');
  });
});

test.serial('a RequestInput node pauses the graph until the answer arrives through an Update', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-hitl-input');
  await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
    const handle = await env.client.workflow.start(hitlInputNode, { taskQueue, workflowId: uid('wf-hitl-input') });
    const [pending] = await waitForPending(handle, 1, ['approval']);
    t.is(pending?.kind, 'input');
    t.is(pending?.message, 'Approve the release?');
    t.is(pending?.functionCallName, 'adk_request_input');
    await handle.executeUpdate(respondHitlUpdate, { args: ['approval', 'ship-it'] });
    const result = await handle.result();
    t.is(result.output, 'approved:ship-it');
    t.is(result.turns, 2);
  });
});

test.serial('a default interrupt id is a UUID and regenerates identically under replay', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-hitl-default-id');
  const workflowId = uid('wf-hitl-default-id');
  // `maxCachedWorkflows: 0` (the `withWorker` default) replays the first turn on
  // every later task, so the id the answer names must come out the same each time.
  await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
    const handle = await env.client.workflow.start(hitlDefaultInterruptId, { taskQueue, workflowId });
    const [pending] = await waitForPending(handle, 1);
    t.regex(pending!.interruptId, UUID_V4);
    await handle.executeUpdate(respondHitlUpdate, { args: [pending!.interruptId, 'Ada'] });
    t.is((await handle.result()).output, 'hello:Ada');
  });
  await Worker.runReplayHistory(
    { workflowsPath, reuseV8Context: REUSE_V8_CONTEXT, plugins: [makePlugin()] },
    await env.client.workflow.getHandle(workflowId).fetchHistory()
  );
});

test.serial('two pending requests accept a partial answer and keep the other pending', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-hitl-two');
  await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
    const handle = await env.client.workflow.start(hitlTwoPending, { taskQueue, workflowId: uid('wf-hitl-two') });
    await waitForPending(handle, 2, ['a', 'b']);
    await handle.executeUpdate(respondHitlUpdate, { args: ['a', 'yes-a'] });
    const [remaining] = await waitForPending(handle, 1, ['b']);
    t.is(remaining?.interruptId, 'b');
    await handle.executeUpdate(respondHitlUpdate, { args: ['b', 'yes-b'] });
    const result = await handle.result();
    t.is(result.output, 'yes-a&yes-b');
    t.is(result.turns, 3);
  });
});

test.serial("an agent's own requestInputTool pause is answered with a text turn", async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-hitl-agent-input');
  await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
    const handle = await env.client.workflow.start(hitlAgentRequestInput, {
      taskQueue,
      workflowId: uid('wf-hitl-agent-input'),
    });
    const [pending] = await waitForPending(handle, 1);
    t.is(pending?.kind, 'input');
    t.is(pending?.message, 'Your name?');
    t.is(pending?.functionCallName, 'adk_request_input');
    // On a plain LlmAgent, ADK 2.0 delivers the human's reply to the model only as
    // ordinary text (the framework call and any function response are removed from
    // the model's context), so the fixture answers with text and tracks the id itself.
    await handle.executeUpdate(answerAsTextUpdate, { args: [pending!.interruptId, 'Ada'] });
    const result = await handle.result();
    t.is(result.text, 'name=Ada');
    t.is(result.turns, 2);
  });
});

test.serial('a confirmation-gated activityAsTool runs its Activity only after approval', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-hitl-confirm');
  const workflowId = uid('wf-hitl-confirm');
  await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
    const handle = await env.client.workflow.start(hitlConfirmActivityTool, { taskQueue, workflowId });
    const [pending] = await waitForPending(handle, 1);
    t.is(pending?.kind, 'confirmation');
    t.is(pending?.toolName, 'dangerActivity');
    // Nothing has run yet: the gate raised the request instead of scheduling the Activity.
    t.is(await scheduledCount(workflowId, 'dangerActivity'), 0);
    t.deepEqual(activities.executionsFor(workflowId), []);
    await handle.executeUpdate(respondHitlUpdate, { args: [pending!.interruptId, { confirmed: true }] });
    const result = await handle.result();
    t.is(result.text, 'done:{"result":"danger-done:prod"}');
  });
  t.is(await scheduledCount(workflowId, 'dangerActivity'), 1);
  t.deepEqual(activities.executionsFor(workflowId), ['dangerActivity:prod']);
});

test.serial('a rejected confirmation never schedules the Activity', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-hitl-reject');
  const workflowId = uid('wf-hitl-reject');
  await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
    const handle = await env.client.workflow.start(hitlConfirmActivityTool, { taskQueue, workflowId });
    const [pending] = await waitForPending(handle, 1);
    await handle.executeUpdate(respondHitlUpdate, { args: [pending!.interruptId, { confirmed: false }] });
    const result = await handle.result();
    t.is(result.text, 'rejected');
  });
  t.is(await scheduledCount(workflowId, 'dangerActivity'), 0);
  t.deepEqual(activities.executionsFor(workflowId), []);
});

test.serial('a confirmation-gated MCP toolset calls the server only after approval', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-hitl-mcp');
  const workflowId = uid('wf-hitl-mcp');
  await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
    const handle = await env.client.workflow.start(hitlConfirmMcpTool, { taskQueue, workflowId });
    const [pending] = await waitForPending(handle, 1);
    t.is(pending?.kind, 'confirmation');
    t.is(pending?.toolName, 'echo');
    t.is(await scheduledCount(workflowId, 'testServer-callTool'), 0);
    await handle.executeUpdate(respondHitlUpdate, { args: [pending!.interruptId, { confirmed: true }] });
    const result = await handle.result();
    t.is(result.text, 'done:{"echoed":"hello"}');
  });
  t.is(await scheduledCount(workflowId, 'testServer-callTool'), 1);
});

test.serial('a plain-text "yes" approves the single pending gate when plainTextToolConfirmation is set', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-hitl-plain');
  const workflowId = uid('wf-hitl-plain');
  await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
    const handle = await env.client.workflow.start(hitlConfirmActivityTool, { taskQueue, workflowId });
    await waitForPending(handle, 1);
    await handle.executeUpdate(plainTextTurnUpdate, { args: ['yes'] });
    const result = await handle.result();
    t.is(result.text, 'done:{"result":"danger-done:prod"}');
  });
  t.deepEqual(activities.executionsFor(workflowId), ['dangerActivity:prod']);
});

test.serial(
  'a gate requested only at run time cannot be resumed in ADK 2.0 and fails the Workflow typed',
  async (t) => {
    const env = getEnv();
    const taskQueue = uid('adk-hitl-dynamic-gate');
    await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
      const handle = await env.client.workflow.start(hitlDynamicGateTool, {
        taskQueue,
        workflowId: uid('wf-hitl-dynamic-gate'),
      });
      const [pending] = await waitForPending(handle, 1);
      t.is(pending?.kind, 'confirmation');
      await handle.executeUpdate(respondHitlUpdate, { args: [pending!.interruptId, { confirmed: true }] });
      // ADK 2.0.0 binds an approval only to a tool whose `checkRequireConfirmation`
      // says the call needs one; a tool that merely called `requestConfirmation()`
      // at run time is refused (`confirmation_not_required`). The plugin's tools
      // declare their gates, and the refusal — a plain ADK error — ends the
      // Workflow as a typed failure instead of a retried Workflow Task.
      const err = await t.throwsAsync(handle.result());
      const failure = findInCauseChain(err, ApplicationFailure);
      t.is(failure?.type, 'GoogleAdkIntentMismatchError');
      t.regex(failure?.message ?? '', /confirmation_not_required/);
    });
  }
);

test.serial("ADK's SecurityPlugin CONFIRM outcome hits the same ADK 2.0 limit; the Activity never runs", async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-hitl-security');
  const workflowId = uid('wf-hitl-security');
  await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
    const handle = await env.client.workflow.start(hitlSecurityPlugin, { taskQueue, workflowId });
    const [pending] = await waitForPending(handle, 1);
    t.is(pending?.kind, 'confirmation');
    t.deepEqual(activities.executionsFor(workflowId), []);
    await handle.executeUpdate(respondHitlUpdate, { args: [pending!.interruptId, { confirmed: true }] });
    const err = await t.throwsAsync(handle.result());
    t.is(findInCauseChain(err, ApplicationFailure)?.type, 'GoogleAdkIntentMismatchError');
  });
  t.deepEqual(activities.executionsFor(workflowId), []);
});

test.serial('a resumed dynamic node fast-forwards its completed Activity child instead of re-running it', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-hitl-dyn-resume');
  const workflowId = uid('wf-hitl-dyn-resume');
  await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
    const handle = await env.client.workflow.start(dynamicResume, { taskQueue, workflowId });
    await waitForPending(handle, 1, ['approve']);
    await handle.executeUpdate(respondHitlUpdate, { args: ['approve', 'go'] });
    const result = await handle.result();
    t.is(result.output, 'fetched-step1|go');
  });
  // The driver body ran twice (before and after the pause); the Activity ran once.
  t.deepEqual(activities.executionsFor(workflowId), ['countedFetch:step1']);
  t.is(await scheduledCount(workflowId, 'countedFetch'), 1);
});

// Wire-format helpers (unit)
test('hitlInputResponse wraps bare values, passes objects through, and refuses a silently coerced string', (t) => {
  const request: HitlRequest = { kind: 'input', interruptId: 'i1', functionCallName: 'adk_request_input' };
  t.deepEqual(hitlInputResponse(request, 'ship-it'), {
    functionResponse: { id: 'i1', name: 'adk_request_input', response: { result: 'ship-it' } },
  });
  t.deepEqual(hitlInputResponse(request, 42).functionResponse?.response, { result: 42 });
  t.deepEqual(hitlInputResponse(request, ['a']).functionResponse?.response, { result: ['a'] });
  t.deepEqual(hitlInputResponse(request, { userResponse: 'x' }).functionResponse?.response, { userResponse: 'x' });
  // '42' would reach the node as the number 42 (ADK parses string answers as JSON
  // unless the schema accepts strings) — refused rather than coerced.
  t.throws(() => hitlInputResponse(request, '42'), {
    instanceOf: TypeError,
    message: /would be delivered to the node as JSON/,
  });
  t.throws(() => hitlInputResponse(request, 'true'), { instanceOf: TypeError });
  // A string schema keeps the text verbatim, so the same answer is fine.
  const stringRequest: HitlRequest = { ...request, responseSchema: { type: 'string' } };
  t.deepEqual(hitlInputResponse(stringRequest, '42').functionResponse?.response, { result: '42' });
  // Wrong kind.
  t.throws(() => hitlInputResponse({ ...request, kind: 'confirmation' }, 'x'), {
    message: /has kind 'confirmation', not 'input'/,
  });
});

test('hitlConfirmationResponse emits the ToolConfirmation shape ADK parses', (t) => {
  const request: HitlRequest = {
    kind: 'confirmation',
    interruptId: 'adk-1',
    functionCallName: 'adk_request_confirmation',
    toolName: 'danger',
  };
  t.deepEqual(hitlConfirmationResponse(request, { confirmed: true }), {
    functionResponse: { id: 'adk-1', name: 'adk_request_confirmation', response: { confirmed: true } },
  });
  t.deepEqual(
    hitlConfirmationResponse(request, { confirmed: false, hint: 'h', payload: { p: 1 } }).functionResponse?.response,
    {
      confirmed: false,
      hint: 'h',
      payload: { p: 1 },
    }
  );
  t.throws(() => hitlConfirmationResponse({ ...request, kind: 'input' }, { confirmed: true }), {
    message: /has kind 'input', not 'confirmation'/,
  });
});

test('pendingHitlRequests reports input and confirmation pauses but drops credential requests', (t) => {
  const events = [
    createEvent({
      author: 'agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'c1',
              name: 'adk_request_credential',
              args: { authConfig: {}, function_call_id: 'orig' },
            },
          },
          { functionCall: { id: 'i1', name: 'adk_request_input', args: { interruptId: 'i1', message: 'Name?' } } },
        ],
      },
      longRunningToolIds: ['c1', 'i1'],
    }),
  ];
  const pending = pendingHitlRequests(events);
  t.deepEqual(
    pending.map((r) => [r.kind, r.interruptId]),
    [['input', 'i1']]
  );
});
