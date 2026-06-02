/**
 * Comprehensive end-to-end tests for the OpenAI Agents Temporal integration.
 *
 * Test 1 and Test 2 assert the full trace tree with `addTemporalSpans` on
 * and off. Test 3 covers unhappy paths. Workers use `maxCachedWorkflows: 0`
 * so every workflow task replays.
 */
import { randomUUID } from 'crypto';
import test from 'ava';
import { withTrace, withCustomSpan } from '@openai/agents-core';
import { Client, WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import type { TestWorkflowEnvironment } from '@temporalio/test-helpers';
import { Worker, createTestWorkflowEnvironment } from '@temporalio/test-helpers';
import {
  OpenAIAgentsPlugin,
  StatelessMCPServerProvider,
  StatefulMCPServerProvider,
  DEDICATED_WORKER_FAILURE_TYPE,
} from '..';
import { FakeModelProvider, textResponse, toolCallResponse, handoffResponse } from './stubs/openai-agents-fakes';
import { installOtelCollector, installAgentSdkCollector } from './helpers/openai-agents-spans';
import * as activities from './activities/openai-agents-comprehensive';
import {
  simpleAgentWorkflow,
  comprehensiveAgentWorkflow,
  retryableModelWorkflow,
  nonRetryableModelWorkflow,
  toolFailureWorkflow,
  brokenStatefulMcpWorkflow,
  crashSignal,
  traceableSignal,
  pingQuery,
  traceableQuery,
  finalizeUpdate,
  traceableUpdate,
} from './workflows/openai-agents-comprehensive';
import { resetPhase1Sync } from './activities/openai-agents-comprehensive';
import {
  mockStatelessMcpFactory,
  mockStatelessMcpBOnlyFactory,
  mockStatefulMcpFactory,
  brokenStatefulMcpFactory,
  compNexusServiceHandler,
  RetryableThenSuccessModelProvider,
  ErrorModelProvider,
} from './stubs/openai-agents-comprehensive';

const workflowsPath = require.resolve('./workflows/openai-agents-comprehensive');

function* bigAgentInitialScript(): Generator<ReturnType<typeof textResponse>> {
  yield toolCallResponse('getWeather', { location: 'Tokyo' });
  yield toolCallResponse('addNumbers', { a: 2, b: 3 });
  yield toolCallResponse('searchDocs', { query: 'hello' });
  yield toolCallResponse('runDbQuery', { sql: 'select 1' });
  yield toolCallResponse('lookupCity_bare', { zip: '10001' });
  yield toolCallResponse('lookupCity_wrapped', { zip: '94016' });
  yield toolCallResponse('delegate_task', { input: 'Look up info, get weather, add numbers' });
  yield toolCallResponse('getWeather', { location: 'Madrid' });
  yield toolCallResponse('addNumbers', { a: 7, b: 11 });
  yield toolCallResponse('lookupCity_bare', { zip: '20001' });
  yield textResponse('All tasks complete');
  yield toolCallResponse('confirmAction', { reason: 'handoff' });
}

function* bigAgentResumeScript(): Generator<ReturnType<typeof textResponse>> {
  yield handoffResponse('transfer_to_AgentB');
  yield toolCallResponse('searchDocs', { query: 'from-B' });
  yield toolCallResponse('runDbQuery', { sql: 'select 2' });
  yield textResponse('done from AgentB');
}

function* singleTurnScript(text: string): Generator<ReturnType<typeof textResponse>> {
  yield textResponse(text);
}

/**
 * Composes the full FakeModelProvider script for one Test 1 / Test 2 run:
 * preamble + child + child wrapped + sessions x 2 + BIG (initial + resume) + small wrapped + finalRound.
 */
function* comprehensiveScript(): Generator<ReturnType<typeof textResponse>> {
  yield* singleTurnScript('preamble done');
  yield* singleTurnScript('child-1 done');
  yield* singleTurnScript('child-2 done');
  yield* singleTurnScript('teal noted');
  yield* singleTurnScript('your favorite color is teal');
  yield* bigAgentInitialScript();
  yield* bigAgentResumeScript();
  yield* singleTurnScript('small done');
  yield* singleTurnScript('final round done');
}

interface BuildPluginOptions {
  addTemporalSpans: boolean;
  connection: import('@temporalio/worker').NativeConnection;
}

function buildPlugin(opts: BuildPluginOptions): OpenAIAgentsPlugin {
  const fakeProvider = new FakeModelProvider(() => comprehensiveScript());
  const stateless = new StatelessMCPServerProvider('mockStatelessMcp', mockStatelessMcpFactory);
  const statelessBOnly = new StatelessMCPServerProvider('mockStatelessMcpBOnly', mockStatelessMcpBOnlyFactory);
  const stateful = new StatefulMCPServerProvider('mockStatefulMcp', mockStatefulMcpFactory, opts.connection);
  return new OpenAIAgentsPlugin({
    modelProvider: fakeProvider,
    mcpServerProviders: [stateless, statelessBOnly, stateful],
    interceptorOptions: {
      addTemporalSpans: opts.addTemporalSpans,
      useOtelInstrumentation: true,
    },
  });
}

interface RunComprehensiveOptions {
  plugin: OpenAIAgentsPlugin;
  env: TestWorkflowEnvironment;
  taskQueue: string;
}

/**
 * Drives one full comprehensive scenario:
 *   - Preamble: simpleAgentWorkflow wrapped in user_pipeline (one worker)
 *   - Comprehensive: started raw, worker A -> crash signal -> worker B, full lifecycle
 *
 * The `plugin` must be constructed BEFORE the outer `withTrace(...)` opens so
 * that `OpenAIAgentsPlugin`'s host-side mirror (`ActivityTracingProcessor`) is
 * registered on the agent-SDK provider when `onTraceStart` fires. Upstream's
 * `MultiTracingProcessor` doesn't replay trace lifecycle for late-added
 * processors, so a plugin constructed inside the trace would miss it.
 */
async function runComprehensive(opts: RunComprehensiveOptions): Promise<void> {
  const { plugin, env, taskQueue } = opts;

  const client = new Client({ connection: env.connection, plugins: [plugin] });

  const simpleWorkflowId = `simple-${randomUUID()}`;
  const compWorkflowId = `comp-${randomUUID()}`;
  const nexusEndpoint = `comp-nexus-${randomUUID()}`;

  // Register the Nexus endpoint up-front so all workers (preamble + phase1 +
  // phase2) can resolve `compNexusService.getCity` invocations against it.
  const endpointIdentifier = await env.createNexusEndpoint(nexusEndpoint, taskQueue);
  try {
    {
      const worker = await Worker.create({
        connection: env.nativeConnection,
        plugins: [plugin],
        workflowsPath,
        activities,
        nexusServices: [compNexusServiceHandler],
        taskQueue,
        maxCachedWorkflows: 0,
      });
      const workerRun = worker.run();
      try {
        await withCustomSpan(
          async () => {
            await client.workflow.execute(simpleAgentWorkflow, {
              args: ['hello'],
              workflowId: simpleWorkflowId,
              taskQueue,
            });
          },
          { data: { name: 'user_pipeline', data: {} } }
        );
      } finally {
        worker.shutdown();
        await workerRun;
      }
    }

    const phase1 = resetPhase1Sync();
    const handle = await client.workflow.start(comprehensiveAgentWorkflow, {
      args: [{ nexusEndpoint }],
      workflowId: compWorkflowId,
      taskQueue,
    });

    {
      const worker1 = await Worker.create({
        connection: env.nativeConnection,
        plugins: [plugin],
        workflowsPath,
        activities,
        nexusServices: [compNexusServiceHandler],
        taskQueue,
        maxCachedWorkflows: 0,
      });
      const worker1Run = worker1.run();
      try {
        // Wait for the workflow to reach its `condition()` block. notifyPhase1Reached
        // resolves this promise from within the activity body, before the workflow
        // blocks, which gives the test a deterministic synchronization point.
        await phase1;

        await handle.query(pingQuery);

        await withCustomSpan(
          async () => {
            await handle.signal(traceableSignal, 'payload');
          },
          { data: { name: 'user_signal_wrap', data: {} } }
        );
        await withCustomSpan(
          async () => {
            await handle.query(traceableQuery);
          },
          { data: { name: 'user_query_wrap', data: {} } }
        );
        await handle.executeUpdate(traceableUpdate, { args: ['x'] });
      } finally {
        worker1.shutdown();
        await worker1Run;
      }
    }

    // Fresh worker: full replay because maxCachedWorkflows=0.
    {
      const worker2 = await Worker.create({
        connection: env.nativeConnection,
        plugins: [plugin],
        workflowsPath,
        activities,
        nexusServices: [compNexusServiceHandler],
        taskQueue,
        maxCachedWorkflows: 0,
      });
      const worker2Run = worker2.run();
      try {
        await handle.signal(crashSignal); // raw
        await withCustomSpan(
          async () => {
            await handle.executeUpdate(finalizeUpdate, { args: ['done'] });
          },
          { data: { name: 'user_update_wrap', data: {} } }
        );
        await handle.result();
      } finally {
        worker2.shutdown();
        await worker2Run;
      }
    }
  } finally {
    await env.deleteNexusEndpoint(endpointIdentifier);
  }
}

// The test driver wraps the entire test body in a `test_root` OTel span so
// every emission from the test driver, workflow worker, activity worker, and
// child workflow worker nests under one root. Each
// expected-tree literal is therefore a one-element array containing a single
// indented tree.
//
// Indentation: two spaces per depth level.
//
// Span contracts that the integration must satisfy for these trees to match:
//
//   - Every worker-side span is a CHILD of its corresponding client-side
//     scheduling span (universal parent-child rule):
//        startWorkflow         -> executeWorkflow
//        signalWorkflow        -> handleSignal
//        queryWorkflow         -> handleQuery
//        updateWorkflow        -> validateUpdate + handleUpdate
//        startChildWorkflow    -> (child) executeWorkflow
//        startActivity         -> executeActivity
//        continueAsNew         -> (continuation) executeWorkflow
//   - One `temporal:executeWorkflow:X` span per workflow execution. Both pre-crash
//     and post-resume body emissions are children of the same span. The
//     continuation execution (after continueAsNew) gets a new
//     `temporal:executeWorkflow:X` parented to its continueAsNew span.
//   - Span IDs are deterministic across replay.
//   - `isReplaying()` gates span emission so each unique span emits exactly once.
//   - MCP `listTools` is called once per `(agent, mcpServer)` pair at agent
//     init inside `runner.run`: 4 listTools span pairs in the BIG agent
//     run (2 servers x 2 agents post-handoff).
//   - Stateful MCP: `connect()` schedules one long-running session activity
//     (`mockStatefulMcp-stateful-server-session`); `cleanup()` cancels it. Tool calls
//     (`listTools`, `callTool`) are separate short activities.

/** Test 1 expected: `addTemporalSpans=true`. */
const EXPECTED_OTEL_TEST_1: string[][] = [
  [
    'test_root',
    '  user_pipeline',
    '    temporal:startWorkflow:simpleAgentWorkflow',
    '      temporal:executeWorkflow:simpleAgentWorkflow',
    '        agent:SimpleAgent',
    '          generation',
    '            temporal:startActivity:invokeModelActivity',
    '              temporal:executeActivity:invokeModelActivity',
    '  temporal:startWorkflow:comprehensiveAgentWorkflow',
    '    temporal:executeWorkflow:comprehensiveAgentWorkflow',
    '      temporal:startActivity:mockStatefulMcp-stateful-server-session',
    '        temporal:executeActivity:mockStatefulMcp-stateful-server-session',
    '      temporal:startActivity:getWeather',
    '        temporal:executeActivity:getWeather',
    '      user_wrap_activity',
    '        temporal:startActivity:getWeatherWithInnerSpan',
    '          temporal:executeActivity:getWeatherWithInnerSpan',
    '            user_inside_activity',
    '      temporal:startChildWorkflow:childAgentWorkflow',
    '        temporal:executeWorkflow:childAgentWorkflow',
    '          agent:ChildAgent',
    '            generation',
    '              temporal:startActivity:invokeModelActivity',
    '                temporal:executeActivity:invokeModelActivity',
    '      user_wrap_child',
    '        temporal:startChildWorkflow:childAgentWorkflow2',
    '          temporal:executeWorkflow:childAgentWorkflow2',
    '            agent:ChildAgent',
    '              generation',
    '                temporal:startActivity:invokeModelActivity',
    '                  temporal:executeActivity:invokeModelActivity',
    '      agent:MemoryAgent',
    '        generation',
    '          temporal:startActivity:invokeModelActivity',
    '            temporal:executeActivity:invokeModelActivity',
    '      agent:MemoryAgent',
    '        generation',
    '          temporal:startActivity:invokeModelActivity',
    '            temporal:executeActivity:invokeModelActivity',
    '      agent:AgentA',
    '        mcp_tools',
    '          temporal:startActivity:mockStatelessMcp-list-tools',
    '            temporal:executeActivity:mockStatelessMcp-list-tools',
    '        mcp_tools',
    '          temporal:startActivity:mockStatefulMcp-stateful-list-tools',
    '            temporal:executeActivity:mockStatefulMcp-stateful-list-tools',
    '        generation',
    '          temporal:startActivity:invokeModelActivity',
    '            temporal:executeActivity:invokeModelActivity',
    '        function:getWeather',
    '          temporal:startActivity:getWeather',
    '            temporal:executeActivity:getWeather',
    '        generation',
    '          temporal:startActivity:invokeModelActivity',
    '            temporal:executeActivity:invokeModelActivity',
    '        function:addNumbers',
    '          user_inside_inline_tool',
    '        generation',
    '          temporal:startActivity:invokeModelActivity',
    '            temporal:executeActivity:invokeModelActivity',
    '        function:searchDocs',
    '          temporal:startActivity:mockStatelessMcp-call-tool',
    '            temporal:executeActivity:mockStatelessMcp-call-tool',
    '        generation',
    '          temporal:startActivity:invokeModelActivity',
    '            temporal:executeActivity:invokeModelActivity',
    '        function:runDbQuery',
    '          temporal:startActivity:mockStatefulMcp-stateful-call-tool',
    '            temporal:executeActivity:mockStatefulMcp-stateful-call-tool',
    '        generation',
    '          temporal:startActivity:invokeModelActivity',
    '            temporal:executeActivity:invokeModelActivity',
    '        function:lookupCity_bare',
    '          temporal:startNexusOperation:compNexusService.getCity',
    '            getCity_handler',
    '        generation',
    '          temporal:startActivity:invokeModelActivity',
    '            temporal:executeActivity:invokeModelActivity',
    '        function:lookupCity_wrapped',
    '          user_wrap_nexus_tool',
    '            temporal:startNexusOperation:compNexusService.getCity',
    '              getCity_handler',
    '        generation',
    '          temporal:startActivity:invokeModelActivity',
    '            temporal:executeActivity:invokeModelActivity',
    '        function:delegate_task',
    '          agent:AssistantAgent',
    '            generation',
    '              temporal:startActivity:invokeModelActivity',
    '                temporal:executeActivity:invokeModelActivity',
    '            function:getWeather',
    '              temporal:startActivity:getWeather',
    '                temporal:executeActivity:getWeather',
    '            generation',
    '              temporal:startActivity:invokeModelActivity',
    '                temporal:executeActivity:invokeModelActivity',
    '            function:addNumbers',
    '              user_inside_inline_tool',
    '            generation',
    '              temporal:startActivity:invokeModelActivity',
    '                temporal:executeActivity:invokeModelActivity',
    '            function:lookupCity_bare',
    '              temporal:startNexusOperation:compNexusService.getCity',
    '                getCity_handler',
    '            generation',
    '              temporal:startActivity:invokeModelActivity',
    '                temporal:executeActivity:invokeModelActivity',
    '        generation',
    '          temporal:startActivity:invokeModelActivity',
    '            temporal:executeActivity:invokeModelActivity',
    '      temporal:continueAsNew',
    '        temporal:executeWorkflow:comprehensiveAgentWorkflow',
    '          temporal:startActivity:mockStatefulMcp-stateful-server-session',
    '            temporal:executeActivity:mockStatefulMcp-stateful-server-session',
    '          mcp_tools',
    '            temporal:startActivity:mockStatelessMcp-list-tools',
    '              temporal:executeActivity:mockStatelessMcp-list-tools',
    '          mcp_tools',
    '            temporal:startActivity:mockStatefulMcp-stateful-list-tools',
    '              temporal:executeActivity:mockStatefulMcp-stateful-list-tools',
    '          function:confirmAction',
    '          agent:AgentA',
    '            generation',
    '              temporal:startActivity:invokeModelActivity',
    '                temporal:executeActivity:invokeModelActivity',
    '            handoff:AgentA->AgentB',
    '          agent:AgentB',
    '            mcp_tools',
    '              temporal:startActivity:mockStatelessMcpBOnly-list-tools',
    '                temporal:executeActivity:mockStatelessMcpBOnly-list-tools',
    '            generation',
    '              temporal:startActivity:invokeModelActivity',
    '                temporal:executeActivity:invokeModelActivity',
    '            function:searchDocs',
    '              temporal:startActivity:mockStatelessMcp-call-tool',
    '                temporal:executeActivity:mockStatelessMcp-call-tool',
    '            generation',
    '              temporal:startActivity:invokeModelActivity',
    '                temporal:executeActivity:invokeModelActivity',
    '            function:runDbQuery',
    '              temporal:startActivity:mockStatefulMcp-stateful-call-tool',
    '                temporal:executeActivity:mockStatefulMcp-stateful-call-tool',
    '            generation',
    '              temporal:startActivity:invokeModelActivity',
    '                temporal:executeActivity:invokeModelActivity',
    '          user_wrap_runner',
    '            agent:SmallAgent',
    '              generation',
    '                temporal:startActivity:invokeModelActivity',
    '                  temporal:executeActivity:invokeModelActivity',
    '          temporal:startActivity:notifyPhase1Reached',
    '            temporal:executeActivity:notifyPhase1Reached',
    '          temporal:startActivity:getWeather',
    '            temporal:executeActivity:getWeather',
    '          temporal:continueAsNew',
    '            temporal:executeWorkflow:comprehensiveAgentWorkflow',
    '              agent:FinalRoundAgent',
    '                generation',
    '                  temporal:startActivity:invokeModelActivity',
    '                    temporal:executeActivity:invokeModelActivity',
    '  temporal:queryWorkflow:ping',
    '    temporal:handleQuery:ping',
    '  user_signal_wrap',
    '    temporal:signalWorkflow:traceableSignal',
    '      temporal:handleSignal:traceableSignal',
    '        user_inside_signal',
    '  user_query_wrap',
    '    temporal:queryWorkflow:traceableQuery',
    '      temporal:handleQuery:traceableQuery',
    '        user_inside_query',
    '  temporal:updateWorkflow:traceableUpdate',
    '    temporal:handleUpdate:traceableUpdate',
    '      user_inside_update',
    '  temporal:signalWorkflow:crashSignal',
    '    temporal:handleSignal:crashSignal',
    '  user_update_wrap',
    '    temporal:updateWorkflow:finalize',
    '      temporal:validateUpdate:finalize',
    '        user_inside_validator',
    '      temporal:handleUpdate:finalize',
  ],
];

/**
 * Test 2 expected: `addTemporalSpans=false`.
 *
 * The `temporal:*` spans are absent. User spans (user_pipeline, user_wrap_*,
 * user_inside_*) and agent-SDK spans (agent:*, generation, function:*,
 * mcp:*, handoff:*) remain. Trace context still propagates across the
 * workflow/activity/child-workflow boundary via headers, so user spans on
 * either side of a boundary nest correctly.
 *
 * Direct operations whose only contributions were `temporal:*` spans
 * disappear entirely (the direct executeActivity, the direct executeChild's
 * workflow-spans, the raw signal/query/update spans, the raw pingQuery,
 * the notifyPhase1Reached activity, the post-resume getWeather, and
 * continueAsNew all contribute nothing).
 *
 * Workflow-body emissions appear directly under `test_root` because there's
 * no `temporal:executeWorkflow` to parent them; trace context flows from
 * `test_root` through the propagated headers to the workflow worker.
 */
const EXPECTED_OTEL_TEST_2: string[][] = [
  [
    'test_root',
    '  user_pipeline',
    '    agent:SimpleAgent',
    '      generation',
    '  user_wrap_activity',
    '    user_inside_activity',
    '  agent:ChildAgent',
    '    generation',
    '  user_wrap_child',
    '    agent:ChildAgent',
    '      generation',
    '  agent:MemoryAgent',
    '    generation',
    '  agent:MemoryAgent',
    '    generation',
    '  agent:AgentA',
    '    mcp_tools',
    '    mcp_tools',
    '    generation',
    '    function:getWeather',
    '    generation',
    '    function:addNumbers',
    '      user_inside_inline_tool',
    '    generation',
    '    function:searchDocs',
    '    generation',
    '    function:runDbQuery',
    '    generation',
    '    function:lookupCity_bare',
    '      getCity_handler',
    '    generation',
    '    function:lookupCity_wrapped',
    '      user_wrap_nexus_tool',
    '        getCity_handler',
    '    generation',
    '    function:delegate_task',
    '      agent:AssistantAgent',
    '        generation',
    '        function:getWeather',
    '        generation',
    '        function:addNumbers',
    '          user_inside_inline_tool',
    '        generation',
    '        function:lookupCity_bare',
    '          getCity_handler',
    '        generation',
    '    generation',
    '  mcp_tools',
    '  mcp_tools',
    '  function:confirmAction',
    '  agent:AgentA',
    '    generation',
    '    handoff:AgentA->AgentB',
    '  agent:AgentB',
    '    mcp_tools',
    '    generation',
    '    function:searchDocs',
    '    generation',
    '    function:runDbQuery',
    '    generation',
    '  user_wrap_runner',
    '    agent:SmallAgent',
    '      generation',
    '  user_signal_wrap',
    '    user_inside_signal',
    '  user_query_wrap',
    '    user_inside_query',
    '  user_inside_update',
    '  user_update_wrap',
    '    user_inside_validator',
    '  agent:FinalRoundAgent',
    '    generation',
  ],
];

/**
 * Spins up a fresh `TestWorkflowEnvironment` for one test and tears it down
 * unconditionally. Each test gets its own server + namespace; the unhappy-path
 * tests share no state and can run concurrently.
 */
async function withTestEnv(fn: (env: TestWorkflowEnvironment) => Promise<void>): Promise<void> {
  const env = await createTestWorkflowEnvironment();
  try {
    await fn(env);
  } finally {
    await env.teardown();
  }
}

test.serial('Comprehensive trace tree: addTemporalSpans=true', async (t) => {
  await withTestEnv(async (env) => {
    const otel = installOtelCollector();
    const agentSdk = installAgentSdkCollector();
    // Construct the plugin before `withTrace(...)` so the agent-SDK -> OTel
    // mirror is on the processor list when `onTraceStart` fires.
    const plugin = buildPlugin({ addTemporalSpans: true, connection: env.nativeConnection });
    try {
      await withTrace('test_root', async () => {
        await runComprehensive({ plugin, env, taskQueue: `comp-1-${randomUUID()}` });
      });

      // OTel and agent-SDK trees are the same single source of truth: agent-SDK
      // spans bridge into OTel via useOtelInstrumentation, and `temporal:*` spans
      // are emitted as agent-SDK custom spans so they reach both streams.
      t.deepEqual(otel.dumpTraces(), EXPECTED_OTEL_TEST_1);
      t.deepEqual(agentSdk.dumpTraces(), EXPECTED_OTEL_TEST_1);
    } finally {
      await otel.teardown();
      await agentSdk.teardown();
    }
  });
});

test.serial('Comprehensive trace tree: addTemporalSpans=false', async (t) => {
  await withTestEnv(async (env) => {
    const otel = installOtelCollector();
    const agentSdk = installAgentSdkCollector();
    // See the addTemporalSpans=true test for the construction-order detail.
    const plugin = buildPlugin({ addTemporalSpans: false, connection: env.nativeConnection });
    try {
      await withTrace('test_root', async () => {
        await runComprehensive({ plugin, env, taskQueue: `comp-2-${randomUUID()}` });
      });

      t.deepEqual(otel.dumpTraces(), EXPECTED_OTEL_TEST_2);
      t.deepEqual(agentSdk.dumpTraces(), EXPECTED_OTEL_TEST_2);
    } finally {
      await otel.teardown();
      await agentSdk.teardown();
    }
  });
});

test('Retryable model error eventually succeeds', async (t) => {
  await withTestEnv(async (env) => {
    const taskQueue = `retry-${randomUUID()}`;
    const modelProvider = new RetryableThenSuccessModelProvider(2, 'recovered', 429);
    const plugin = new OpenAIAgentsPlugin({
      modelProvider,
      modelParams: {
        retry: { maximumAttempts: 5, initialInterval: '50ms', backoffCoefficient: 1.5 },
      },
    });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      plugins: [plugin],
      workflowsPath,
      taskQueue,
    });
    const client = new Client({ connection: env.connection, plugins: [plugin] });
    await worker.runUntil(async () => {
      const result = await client.workflow.execute(retryableModelWorkflow, {
        args: ['hello'],
        workflowId: `retry-${randomUUID()}`,
        taskQueue,
        workflowExecutionTimeout: '30 seconds',
      });
      t.is(result, 'recovered');
    });
  });
});

test('Non-retryable model error fails workflow with classified ApplicationFailure.type', async (t) => {
  await withTestEnv(async (env) => {
    const taskQueue = `non-retry-${randomUUID()}`;
    const modelProvider = new ErrorModelProvider(400);
    const plugin = new OpenAIAgentsPlugin({ modelProvider });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      plugins: [plugin],
      workflowsPath,
      taskQueue,
    });
    const client = new Client({ connection: env.connection, plugins: [plugin] });
    await worker.runUntil(async () => {
      const err = (await t.throwsAsync(
        client.workflow.execute(nonRetryableModelWorkflow, {
          args: ['hello'],
          workflowId: `non-retry-${randomUUID()}`,
          taskQueue,
          workflowExecutionTimeout: '30 seconds',
        }),
        { instanceOf: WorkflowFailedError }
      )) as WorkflowFailedError;

      const cause = err.cause?.cause;
      t.true(cause instanceof ApplicationFailure, 'cause.cause must be ApplicationFailure');
      t.is((cause as ApplicationFailure).type, 'ModelInvocationError.BadRequest');
    });
  });
});

test('Activity-backed tool failure crashes workflow with AgentsWorkflowError (Python parity)', async (t) => {
  await withTestEnv(async (env) => {
    const taskQueue = `tool-fail-${randomUUID()}`;
    // Python parity: when an activity-backed tool throws, the failure is NOT
    // fed back to the agent loop; it propagates as an ActivityFailure and the
    // runner wraps it as a non-retryable AgentsWorkflowError, crashing the
    // workflow. The model only needs the first toolCallResponse; the second
    // turn never happens.
    const modelProvider = new FakeModelProvider(() => {
      function* gen() {
        yield toolCallResponse('failingTool', { reason: 'no-reason' });
      }
      return gen();
    });
    const plugin = new OpenAIAgentsPlugin({ modelProvider });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      plugins: [plugin],
      workflowsPath,
      activities,
      taskQueue,
    });
    const client = new Client({ connection: env.connection, plugins: [plugin] });
    await worker.runUntil(async () => {
      const err = (await t.throwsAsync(
        client.workflow.execute(toolFailureWorkflow, {
          args: ['use the failing tool please'],
          workflowId: `tool-fail-${randomUUID()}`,
          taskQueue,
          workflowExecutionTimeout: '30 seconds',
        }),
        { instanceOf: WorkflowFailedError }
      )) as WorkflowFailedError;

      const cause = err.cause;
      t.true(cause instanceof ApplicationFailure, 'cause must be ApplicationFailure');
      t.is((cause as ApplicationFailure).type, 'AgentsWorkflowError');
    });
  });
});

test('Stateful MCP dedicated-worker failure produces DedicatedWorkerFailure', async (t) => {
  await withTestEnv(async (env) => {
    const taskQueue = `broken-mcp-${randomUUID()}`;
    const provider = new StatefulMCPServerProvider('brokenStatefulMcp', brokenStatefulMcpFactory, env.nativeConnection);
    const modelProvider = new FakeModelProvider([]);
    const plugin = new OpenAIAgentsPlugin({
      modelProvider,
      mcpServerProviders: [provider],
    });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      plugins: [plugin],
      workflowsPath,
      taskQueue,
    });
    const client = new Client({ connection: env.connection, plugins: [plugin] });
    await worker.runUntil(async () => {
      const err = (await t.throwsAsync(
        client.workflow.execute(brokenStatefulMcpWorkflow, {
          args: [],
          workflowId: `broken-mcp-${randomUUID()}`,
          taskQueue,
          workflowExecutionTimeout: '20 seconds',
        }),
        { instanceOf: WorkflowFailedError }
      )) as WorkflowFailedError;

      const cause = err.cause;
      t.true(cause instanceof ApplicationFailure, 'cause must be ApplicationFailure');
      t.is((cause as ApplicationFailure).type, DEDICATED_WORKER_FAILURE_TYPE);
    });
  });
});
