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
import {
  hitlConfirmationResponse,
  hitlInputResponse,
  pendingHitlRequests,
  HITL_RESPONSE_FAILURE_TYPE,
  type HitlConfirmation,
  type HitlConfirmationRequest,
  type HitlInputRequest,
  type HitlRequest,
} from '../workflow';
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
  hitlStructuredInput,
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

test.serial('an answer the builder refuses rejects the Update and leaves the Workflow healthy', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-hitl-reject-answer');
  const workflowId = uid('wf-hitl-reject-answer');
  await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
    const handle = await env.client.workflow.start(hitlInputNode, { taskQueue, workflowId });
    await waitForPending(handle, 1, ['approval']);

    // The handler builds the Part, so the coercion guard runs while the caller can
    // still hear about it: '42' has no string schema and would reach the node as 42.
    const rejected = await t.throwsAsync(handle.executeUpdate(respondHitlUpdate, { args: ['approval', '42'] }));
    t.is(findInCauseChain(rejected, ApplicationFailure)?.type, 'GoogleAdkHitlResponseError');
    // An id nothing is waiting on is refused the same way.
    const unknownId = await t.throwsAsync(handle.executeUpdate(respondHitlUpdate, { args: ['nope', 1] }));
    t.is(findInCauseChain(unknownId, ApplicationFailure)?.type, 'GoogleAdkHitlResponseError');

    // The interrupt is still open, so the parsed value is accepted and the run finishes.
    await handle.executeUpdate(respondHitlUpdate, { args: ['approval', 42] });
    t.is((await handle.result()).output, 'approved:42');
  });
  // A rejected Update must not have failed a Workflow Task: that would retry the
  // task forever with the bad answer already committed to history.
  const { events } = await getEnv().client.workflow.getHandle(workflowId).fetchHistory();
  t.deepEqual(
    (events ?? []).filter((e) => e.workflowTaskFailedEventAttributes != null),
    []
  );
});

test.serial('a malformed confirmation decision rejects the Update and the corrected one runs the tool', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-hitl-bad-decision');
  const workflowId = uid('wf-hitl-bad-decision');
  await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
    const handle = await env.client.workflow.start(hitlConfirmActivityTool, { taskQueue, workflowId });
    const [pending] = await waitForPending(handle, 1);
    const interruptId = pending!.interruptId;

    // `null` used to be dereferenced as a decision, throwing a TypeError that failed the
    // Workflow Task instead of rejecting this Update.
    const nullDecision = await t.throwsAsync(handle.executeUpdate(respondHitlUpdate, { args: [interruptId, null] }));
    t.is(findInCauseChain(nullDecision, ApplicationFailure)?.type, 'GoogleAdkHitlResponseError');
    // A decision whose `confirmed` is not a boolean is refused rather than read as a rejection.
    const stringConfirmed = await t.throwsAsync(
      handle.executeUpdate(respondHitlUpdate, { args: [interruptId, { confirmed: 'yes' }] })
    );
    t.is(findInCauseChain(stringConfirmed, ApplicationFailure)?.type, 'GoogleAdkHitlResponseError');
    t.deepEqual(activities.executionsFor(workflowId), []);

    // The gate is still open, so the corrected decision approves and the Activity runs once.
    await handle.executeUpdate(respondHitlUpdate, { args: [interruptId, { confirmed: true }] });
    t.is((await handle.result()).text, 'done:{"result":"danger-done:prod"}');
  });
  t.deepEqual(activities.executionsFor(workflowId), ['dangerActivity:prod']);
  const { events } = await getEnv().client.workflow.getHandle(workflowId).fetchHistory();
  t.deepEqual(
    (events ?? []).filter((e) => e.workflowTaskFailedEventAttributes != null),
    []
  );
});

test.serial(
  'a structured answer that fails its responseSchema rejects the Update and the corrected one runs',
  async (t) => {
    const env = getEnv();
    const taskQueue = uid('adk-hitl-structured');
    const workflowId = uid('wf-hitl-structured');
    await withWorker(env, { taskQueue, plugins: [makePlugin()], activities }, async () => {
      const handle = await env.client.workflow.start(hitlStructuredInput, { taskQueue, workflowId });
      await waitForPending(handle, 1, ['structured']);

      // ADK would refuse this on resume with a plain Error, failing the Workflow Task
      // forever; the builder applies ADK's check first, so the Update is rejected instead.
      const rejected = await t.throwsAsync(
        handle.executeUpdate(respondHitlUpdate, { args: ['structured', { name: 123 }] })
      );
      const failure = findInCauseChain(rejected, ApplicationFailure);
      t.is(failure?.type, 'GoogleAdkHitlResponseError');
      t.regex(failure?.message ?? '', /does not match the responseSchema it declared: .* at 'name'/);

      // The interrupt is still open, so a schema-valid answer completes the run.
      await handle.executeUpdate(respondHitlUpdate, { args: ['structured', { name: 'ok' }] });
      t.is((await handle.result()).output, 'hello:ok');
    });
    const { events } = await getEnv().client.workflow.getHandle(workflowId).fetchHistory();
    t.deepEqual(
      (events ?? []).filter((e) => e.workflowTaskFailedEventAttributes != null),
      []
    );
  }
);

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
  const request: HitlInputRequest = { kind: 'input', interruptId: 'i1', functionCallName: 'adk_request_input' };
  t.deepEqual(hitlInputResponse(request, 'ship-it'), {
    functionResponse: { id: 'i1', name: 'adk_request_input', response: { result: 'ship-it' } },
  });
  t.deepEqual(hitlInputResponse(request, 42).functionResponse?.response, { result: 42 });
  t.deepEqual(hitlInputResponse(request, ['a']).functionResponse?.response, { result: ['a'] });
  t.deepEqual(hitlInputResponse(request, { userResponse: 'x' }).functionResponse?.response, { userResponse: 'x' });
  // '42' would reach the node as the number 42 (ADK parses string answers as JSON
  // unless the schema accepts strings) — refused rather than coerced.
  // A non-retryable ApplicationFailure, not a TypeError: only a TemporalFailure
  // rejects the Update whose handler builds the Part.
  const refused = t.throws(() => hitlInputResponse(request, '42'), {
    instanceOf: ApplicationFailure,
    message: /parses as JSON, so ADK would deliver 42 \(number\)/,
  });
  t.is(refused?.type, HITL_RESPONSE_FAILURE_TYPE);
  t.is(refused?.nonRetryable, true);
  t.throws(() => hitlInputResponse(request, 'true'), { instanceOf: ApplicationFailure });
  // A quoted string parses to a *string*, and ADK still returns the parsed value,
  // so the node would see `foo` rather than `"foo"`.
  t.throws(() => hitlInputResponse(request, '"foo"'), {
    instanceOf: ApplicationFailure,
    message: /so ADK would deliver the string "foo" to the node/,
  });
  // Text that is not JSON at all reaches the node verbatim, so it is allowed.
  t.deepEqual(hitlInputResponse(request, 'ship it').functionResponse?.response, { result: 'ship it' });
  // ADK unwraps any single-key `{ result: … }` object, so the same coercion applies
  // to an object the caller wrote itself.
  t.throws(() => hitlInputResponse(request, { result: '42' }), { instanceOf: ApplicationFailure });
  // A second key defeats the unwrap, so the object arrives whole and nothing is parsed.
  t.deepEqual(hitlInputResponse(request, { result: '42', unit: 'm' }).functionResponse?.response, {
    result: '42',
    unit: 'm',
  });
  // A string schema keeps the text verbatim, so the same answer is fine.
  const stringRequest: HitlInputRequest = { ...request, responseSchema: { type: 'string' } };
  t.deepEqual(hitlInputResponse(stringRequest, '42').functionResponse?.response, { result: '42' });
  // Wrong kind. The signature rejects it at compile time; the cast stands in for a
  // request that reached a Client as plain JSON over a Query, where it cannot.
  t.throws(() => hitlInputResponse({ ...request, kind: 'confirmation' } as unknown as HitlInputRequest, 'x'), {
    message: /has kind 'confirmation', not 'input'/,
  });
  // A credential request is not in `HitlRequest` at all, and is refused by name.
  t.throws(
    () =>
      hitlInputResponse(
        {
          kind: 'credential',
          interruptId: 'c1',
          functionCallName: 'adk_request_credential',
        } as unknown as HitlInputRequest,
        'x'
      ),
    { message: /Credential requests are not answerable from a Workflow/ }
  );
});

test('hitlInputResponse refuses only with the typed failure, including values ADK cannot use', (t) => {
  const request: HitlInputRequest = { kind: 'input', interruptId: 'i1', functionCallName: 'adk_request_input' };
  const assertTyped = (fn: () => unknown, message: RegExp) => {
    const err = t.throws(fn, { instanceOf: ApplicationFailure, message });
    t.is(err?.type, HITL_RESPONSE_FAILURE_TYPE);
    t.is(err?.nonRetryable, true);
  };
  // ADK resumes a waiting node only on an answer `!== undefined`, so this would read as
  // no answer while `pendingHitlRequests` already counted the request as answered.
  assertTyped(() => hitlInputResponse(request, undefined), /is undefined, which ADK reads as no answer at all/);
  // Not JSON, so not something a Client could have sent over an Update either.
  assertTyped(() => hitlInputResponse(request, () => 1), /is a function, which is not a JSON value/);
  assertTyped(() => hitlInputResponse(request, Symbol('x')), /is a symbol, which is not a JSON value/);
  assertTyped(() => hitlInputResponse(request, 10n), /is a bigint, which is not a JSON value/);
  // A request that crossed a Query boundary as something other than an object.
  assertTyped(() => hitlInputResponse(null as unknown as HitlInputRequest, 'x'), /is not a HITL request/);
  // `null` is a JSON value, delivered as such.
  t.deepEqual(hitlInputResponse(request, null).functionResponse?.response, { result: null });
});

test('hitlInputResponse refuses a structured answer its responseSchema rejects, as ADK would', (t) => {
  // The JSON Schema ADK records for `RequestInput({ responseSchema: z.object({ name: z.string() }) })`.
  const request: HitlInputRequest = {
    kind: 'input',
    interruptId: 'structured',
    functionCallName: 'adk_request_input',
    responseSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  };
  const refuse = (value: unknown, message: RegExp) => {
    const err = t.throws(() => hitlInputResponse(request, value), { instanceOf: ApplicationFailure, message });
    t.is(err?.type, HITL_RESPONSE_FAILURE_TYPE);
    t.is(err?.nonRetryable, true);
  };
  // ADK's own message, issues and all, behind the helper's name.
  refuse(
    { name: 123 },
    /^hitlInputResponse: The reply to interrupt 'structured' does not match the responseSchema it declared: Invalid input: expected string, received number at 'name'\./
  );
  // ADK unwraps the envelope first, so a wrapped object is checked too.
  refuse({ result: { name: 123 } }, /does not match the responseSchema it declared/);
  // Arrays are objects to ADK's check, so they are held to the schema as well.
  refuse([{ name: 'ok' }], /expected object, received array/);
  refuse({ name: 'ok', extra: 1 }, /Unrecognized key: "extra"/);

  t.deepEqual(hitlInputResponse(request, { name: 'ok' }).functionResponse?.response, { name: 'ok' });
  // ADK exempts a bare scalar (the chat-box reply), so the builder does too.
  t.deepEqual(hitlInputResponse(request, 5).functionResponse?.response, { result: 5 });
  // A schema zod cannot compile is "no contract to check" for ADK, and here.
  t.deepEqual(
    hitlInputResponse({ ...request, responseSchema: { type: 'nonsense' } }, { name: 123 }).functionResponse?.response,
    { name: 123 }
  );
});

test('hitlConfirmationResponse refuses a malformed decision with the typed failure', (t) => {
  const request: HitlConfirmationRequest = {
    kind: 'confirmation',
    interruptId: 'adk-1',
    functionCallName: 'adk_request_confirmation',
  };
  const refuse = (decision: unknown, message: RegExp) => {
    const err = t.throws(() => hitlConfirmationResponse(request, decision as HitlConfirmation), {
      instanceOf: ApplicationFailure,
      message,
    });
    t.is(err?.type, HITL_RESPONSE_FAILURE_TYPE);
    t.is(err?.nonRetryable, true);
  };
  refuse(null, /decision for interrupt 'adk-1' must be an object .* got null/);
  refuse(undefined, /must be an object .* got undefined/);
  refuse('yes', /must be an object .* got a string/);
  refuse([true], /must be an object .* got an array/);
  // ADK approves only on `=== true`; anything else must not be guessed as either answer.
  refuse({ confirmed: 'yes' }, /'confirmed' must be a boolean, got a string/);
  refuse({}, /'confirmed' must be a boolean, got undefined/);
  refuse({ confirmed: true, hint: 42 }, /'hint' must be a string when present, got a number/);
  refuse(null, /^hitlConfirmationResponse: /);
  t.throws(() => hitlConfirmationResponse(null as unknown as HitlConfirmationRequest, { confirmed: true }), {
    instanceOf: ApplicationFailure,
    message: /is not a HITL request/,
  });
  // A well-formed decision still goes through, payload untouched.
  t.deepEqual(hitlConfirmationResponse(request, { confirmed: false, payload: null }).functionResponse?.response, {
    confirmed: false,
    payload: null,
  });
});

test('hitlConfirmationResponse emits the ToolConfirmation shape ADK parses', (t) => {
  const request: HitlConfirmationRequest = {
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
  t.throws(
    () =>
      hitlConfirmationResponse({ ...request, kind: 'input' } as unknown as HitlConfirmationRequest, {
        confirmed: true,
      }),
    { message: /has kind 'input', not 'confirmation'/ }
  );
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
