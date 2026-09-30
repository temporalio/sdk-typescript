/**
 * Workflows for the OpenAI Agents comprehensive E2E test suite.
 *
 * `comprehensiveAgentWorkflow` drives the trace tree: each Temporal operation
 * appears direct and user-span-wrapped, handlers cover signal/query/update
 * paths, and the crash boundary is the resume execution's `condition()`.
 */
import { Agent, RunState, tool, withCustomSpan, createCustomSpan, type Tool } from '@openai/agents-core';
import { Capability, SandboxAgent, type SandboxSessionLike } from '@openai/agents-core/sandbox';
import * as nexus from 'nexus-rpc';
import {
  condition,
  continueAsNew,
  createNexusServiceClient,
  defineQuery,
  defineSignal,
  defineUpdate,
  executeChild,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import {
  activityAsTool,
  agentAsTool,
  nexusOperationAsTool,
  TemporalOpenAIRunner,
  WorkflowSafeMemorySession,
  statelessMcpServer,
  statefulMcpServer,
  temporalSandboxClient,
} from '../../workflow';
import type * as activities from '../activities/openai-agents-comprehensive';

const acts = proxyActivities<typeof activities>({ startToCloseTimeout: '30s' });

export interface CompNexusGetCityInput {
  zip: string;
}

export interface CompNexusGetCityOutput {
  city: string;
}

export const compNexusService = nexus.service('compNexusService', {
  getCity: nexus.operation<CompNexusGetCityInput, CompNexusGetCityOutput>(),
});

/** Unblocks the comprehensive Workflow's `condition()`. Handler emits no user span (contrast with `traceableSignal`). */
export const crashSignal = defineSignal('crashSignal');
export const traceableSignal = defineSignal<[string]>('traceableSignal');

export const pingQuery = defineQuery<string>('ping');
export const traceableQuery = defineQuery<string>('traceableQuery');

export const finalizeUpdate = defineUpdate<string, [string]>('finalize');
export const traceableUpdate = defineUpdate<string, [string]>('traceableUpdate');

/**
 * One model call, no tools. Started under a `user_pipeline` outer span by the
 * test driver; assertion verifies that `temporal:startWorkflow:*` and the
 * subsequent worker-side spans nest under `user_pipeline`.
 */
export async function simpleAgentWorkflow(prompt: string): Promise<string> {
  const agent = new Agent({
    name: 'SimpleAgent',
    instructions: 'You are a helpful assistant.',
    model: 'gpt-4o-mini',
  });
  const runner = new TemporalOpenAIRunner();
  const result = await runner.run(agent, prompt);
  return result.finalOutput ?? '';
}

export async function childAgentWorkflow(input: string): Promise<string> {
  const agent = new Agent({
    name: 'ChildAgent',
    instructions: 'Answer briefly.',
    model: 'gpt-4o-mini',
  });
  const runner = new TemporalOpenAIRunner();
  const result = await runner.run(agent, input);
  return result.finalOutput ?? '';
}

export async function childAgentWorkflow2(input: string): Promise<string> {
  return childAgentWorkflow(input);
}

export interface ComprehensiveInput {
  /** `true` on the post-resume final continueAsNew execution. */
  finalRound?: boolean;
  /** Serialized `RunState.toString()` from an approval interruption; set on the continueAsNew that follows the initial execution. */
  resumeFromRunState?: string;
  /** Nexus endpoint name to route `compNexusService` operations to. Required for the initial + resume executions. */
  nexusEndpoint?: string;
}

class ComprehensiveSandboxCapability extends Capability {
  readonly type = 'comprehensive_sandbox';

  private session(): SandboxSessionLike {
    if (!this._session) throw new Error('comprehensive_sandbox capability is not bound to a session');
    return this._session;
  }

  override tools(): Tool<any>[] {
    return [
      tool({
        name: 'run_command',
        description: 'run_command',
        parameters: {
          type: 'object' as const,
          properties: { cmd: { type: 'string' } },
          required: ['cmd'] as const,
          additionalProperties: false as const,
        },
        execute: async (args, _ctx) => {
          const { cmd } = args as { cmd: string };
          return this.session().execCommand!({ cmd });
        },
      }),
      tool({
        name: 'read_file',
        description: 'read_file',
        parameters: {
          type: 'object' as const,
          properties: { path: { type: 'string' } },
          required: ['path'] as const,
          additionalProperties: false as const,
        },
        execute: async (args, _ctx) => {
          const { path } = args as { path: string };
          const data = await this.session().readFile!({ path });
          return typeof data === 'string' ? data : new TextDecoder().decode(data);
        },
      }),
      tool({
        name: 'write_file',
        description: 'write_file',
        parameters: {
          type: 'object' as const,
          properties: { path: { type: 'string' }, diff: { type: 'string' } },
          required: ['path', 'diff'] as const,
          additionalProperties: false as const,
        },
        execute: async (args, _ctx) => {
          const { path, diff } = args as { path: string; diff: string };
          const editor = this.session().createEditor!();
          const result = await editor.createFile({ type: 'create_file', path, diff });
          return result?.output ?? 'ok';
        },
      }),
    ];
  }
}

async function runSandboxAgent(): Promise<void> {
  const agent = new SandboxAgent({
    name: 'SandboxAgent',
    model: 'gpt-4o-mini',
    capabilities: [new ComprehensiveSandboxCapability()],
  });
  const runner = new TemporalOpenAIRunner();
  await runner.run(agent, 'exercise the sandbox', {
    runConfig: { sandbox: { client: temporalSandboxClient('fake') } },
  });
}

export async function comprehensiveAgentWorkflow(input: ComprehensiveInput = {}): Promise<string> {
  if (input.finalRound) {
    const finalAgent = new Agent({
      name: 'FinalRoundAgent',
      instructions: 'Conclude the conversation.',
      model: 'gpt-4o-mini',
    });
    const runner = new TemporalOpenAIRunner();
    const result = await runner.run(finalAgent, 'Wrap it up');
    return result.finalOutput ?? 'completed';
  }

  if (!input.nexusEndpoint) {
    throw new Error('comprehensiveAgentWorkflow: nexusEndpoint is required outside the finalRound execution');
  }
  const nexusEndpoint = input.nexusEndpoint;

  const setup = buildAgentSetup(nexusEndpoint);
  await setup.stateful.connect();

  let signalReceived = false;
  let finalizeReceived = false;
  let serializedRunState: string | undefined;

  try {
    setHandler(crashSignal, () => {
      signalReceived = true;
    });

    setHandler(traceableSignal, async (_payload: string) => {
      await withCustomSpan(async () => {}, { data: { name: 'user_inside_signal', data: {} } });
    });

    setHandler(pingQuery, () => 'pong');

    // Query handlers must be sync, so use createCustomSpan + manual start/end.
    setHandler(traceableQuery, () => {
      const span = createCustomSpan({ data: { name: 'user_inside_query', data: {} } });
      span.start();
      try {
        return 'query-handled';
      } finally {
        span.end();
      }
    });

    setHandler(
      finalizeUpdate,
      (value: string) => {
        finalizeReceived = true;
        return `finalized-${value}`;
      },
      {
        validator: (value: string) => {
          // Validators must be sync, so use createCustomSpan + manual start/end.
          const span = createCustomSpan({ data: { name: 'user_inside_validator', data: {} } });
          span.start();
          try {
            if (!value) throw new Error('value required');
          } finally {
            span.end();
          }
        },
      }
    );

    setHandler(traceableUpdate, async (value: string) => {
      return withCustomSpan(async () => `traceable-${value}`, {
        data: { name: 'user_inside_update', data: {} },
      });
    });

    if (input.resumeFromRunState !== undefined) {
      const resumeRunner = new TemporalOpenAIRunner();
      const state = await RunState.fromString(setup.agentA, input.resumeFromRunState);
      for (const interruption of state.getInterruptions()) {
        state.approve(interruption);
      }
      await resumeRunner.run(setup.agentA, state, { maxTurns: 12 });

      await withCustomSpan(
        async () => {
          const smallAgent = new Agent({
            name: 'SmallAgent',
            instructions: 'Be brief.',
            model: 'gpt-4o-mini',
          });
          const smallRunner = new TemporalOpenAIRunner();
          await smallRunner.run(smallAgent, 'one line');
        },
        { data: { name: 'user_wrap_runner', data: {} } }
      );

      // notifyPhase1Reached resolves the test driver's `phase1` promise so the
      // driver can deterministically shut down worker A. condition() then blocks
      // the workflow until crashSignal arrives on worker B.
      await acts.notifyPhase1Reached();
      await condition(() => signalReceived);

      await acts.getWeather({ location: 'Paris' });

      await condition(() => finalizeReceived);
    } else {
      // Pattern: each Temporal-touchable operation appears once direct and once
      // wrapped in a user OTel span. The expected trace tree is built off this
      // exact sequence; do not reorder without updating the tree.

      await acts.getWeather({ location: 'Tokyo' });

      await withCustomSpan(
        async () => {
          await acts.getWeatherWithInnerSpan({ location: 'Berlin' });
        },
        { data: { name: 'user_wrap_activity', data: {} } }
      );

      await executeChild(childAgentWorkflow, {
        args: ['hi from comprehensive'],
        workflowId: `${workflowInfo().workflowId}-child-1`,
      });

      await withCustomSpan(
        async () => {
          await executeChild(childAgentWorkflow2, {
            args: ['hi from wrapper'],
            workflowId: `${workflowInfo().workflowId}-child-2`,
          });
        },
        { data: { name: 'user_wrap_child', data: {} } }
      );

      const sessionRunner = new TemporalOpenAIRunner();
      const memAgent = new Agent({
        name: 'MemoryAgent',
        instructions: 'Use the conversation history to answer.',
        model: 'gpt-4o-mini',
      });
      const session = new WorkflowSafeMemorySession({ sessionId: `${workflowInfo().workflowId}-memory` });
      await sessionRunner.run(memAgent, 'My favorite color is teal.', { session });
      await sessionRunner.run(memAgent, 'What did I just tell you?', { session });

      await runSandboxAgent();

      const bigRunner = new TemporalOpenAIRunner();
      const result = await bigRunner.run(setup.agentA, 'Triage me', { maxTurns: 12 });
      if (result.interruptions.length === 0) {
        throw new Error('expected confirmAction approval interruption, got none');
      }
      serializedRunState = result.state.toString();
    }
  } finally {
    await setup.stateful.cleanup();
  }

  if (serializedRunState !== undefined) {
    await continueAsNew<typeof comprehensiveAgentWorkflow>({
      resumeFromRunState: serializedRunState,
      nexusEndpoint,
    });
  } else {
    await continueAsNew<typeof comprehensiveAgentWorkflow>({ finalRound: true });
  }
  return 'unreachable';
}

interface AgentSetup {
  agentA: Agent<unknown>;
  stateful: ReturnType<typeof statefulMcpServer>;
}

/**
 * Initial and resume executions both call this so the rehydrated `RunState` sees an identical
 * agent surface; `RunState.fromString` matches tool/handoff names against the resuming agent.
 */
function buildAgentSetup(nexusEndpoint: string): AgentSetup {
  const weatherTool = activityAsTool<typeof activities.getWeather>({
    name: 'getWeather',
    description: 'Get the weather for a city',
    parameters: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location'],
      additionalProperties: false,
    },
  });

  const addNumbersTool = tool({
    name: 'addNumbers',
    description: 'Add two numbers',
    parameters: {
      type: 'object' as const,
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'] as const,
      additionalProperties: false as const,
    },
    execute: async (args, _ctx) => {
      const { a, b } = args as { a: number; b: number };
      return withCustomSpan(async () => String(a + b), { data: { name: 'user_inside_inline_tool', data: {} } });
    },
  });

  const lookupCityBareTool = nexusOperationAsTool(
    compNexusService.operations.getCity,
    {
      name: 'lookupCity_bare',
      description: 'Look up a city by ZIP via Nexus',
      parameters: {
        type: 'object',
        properties: { zip: { type: 'string' } },
        required: ['zip'],
        additionalProperties: false,
      },
    },
    { service: compNexusService, endpoint: nexusEndpoint }
  );

  const lookupCityWrappedTool = tool({
    name: 'lookupCity_wrapped',
    description: 'Look up a city by ZIP via Nexus, inside a user span',
    parameters: {
      type: 'object' as const,
      properties: { zip: { type: 'string' } },
      required: ['zip'] as const,
      additionalProperties: false as const,
    },
    execute: async (args, _ctx) => {
      const { zip } = args as { zip: string };
      return withCustomSpan(
        async () => {
          const client = createNexusServiceClient({
            service: compNexusService,
            endpoint: nexusEndpoint,
          });
          const result = await client.executeOperation(compNexusService.operations.getCity, { zip }, {});
          return JSON.stringify(result);
        },
        { data: { name: 'user_wrap_nexus_tool', data: {} } }
      );
    },
  });

  const assistantAgent = new Agent({
    name: 'AssistantAgent',
    instructions: 'You are a general assistant. Use the available tools to answer the user.',
    model: 'gpt-4o-mini',
    tools: [weatherTool, addNumbersTool, lookupCityBareTool],
  });
  const assistantSpecialistTool = agentAsTool(assistantAgent, {
    toolName: 'delegate_task',
    toolDescription: 'Delegate a task to a general assistant that can look things up, get weather, and do math',
  });

  const confirmActionTool = tool({
    name: 'confirmAction',
    description: 'Confirm a destructive action before proceeding',
    parameters: {
      type: 'object' as const,
      properties: { reason: { type: 'string' } },
      required: ['reason'] as const,
      additionalProperties: false as const,
    },
    needsApproval: true,
    execute: async (args, _ctx) => {
      const { reason } = args as { reason: string };
      return `confirmed:${reason}`;
    },
  });

  const stateless = statelessMcpServer('mockStatelessMcp');
  const statelessBOnly = statelessMcpServer('mockStatelessMcpBOnly');
  const stateful = statefulMcpServer('mockStatefulMcp');

  const agentB = new Agent({
    name: 'AgentB',
    instructions: 'You are a specialist; you have MCP-backed tools.',
    model: 'gpt-4o-mini',
    tools: [weatherTool, addNumbersTool],
    mcpServers: [stateless, stateful, statelessBOnly],
  });

  const agentA = new Agent({
    name: 'AgentA',
    instructions: 'You are the triage agent; hand off to AgentB after one tool call.',
    model: 'gpt-4o-mini',
    tools: [
      weatherTool,
      addNumbersTool,
      lookupCityBareTool,
      lookupCityWrappedTool,
      assistantSpecialistTool,
      confirmActionTool,
    ],
    mcpServers: [stateless, stateful],
    handoffs: [agentB],
  });

  return { agentA, stateful };
}

/**
 * Workflow whose model fails transiently N times then succeeds. The runner's
 * retry policy is configured to permit at least N+1 attempts. Test 3 asserts
 * the workflow completes successfully and the model activity appears in
 * history with > 1 attempt.
 */
export async function retryableModelWorkflow(prompt: string): Promise<string> {
  const agent = new Agent({
    name: 'RetryAgent',
    instructions: 'You are a helpful assistant.',
    model: 'gpt-4o-mini',
  });
  const runner = new TemporalOpenAIRunner();
  const result = await runner.run(agent, prompt);
  return result.finalOutput ?? '';
}

/**
 * Workflow whose model fails with a non-retryable error (HTTP 400-equivalent).
 * Test 3 asserts the workflow fails and the resulting `ApplicationFailure.type`
 * matches the integration's classified error type for 400.
 */
export async function nonRetryableModelWorkflow(prompt: string): Promise<string> {
  const agent = new Agent({
    name: 'NonRetryAgent',
    instructions: 'You are a helpful assistant.',
    model: 'gpt-4o-mini',
  });
  // No retry policy override: the activity must be marked non-retryable by
  // the integration's error classifier.
  const runner = new TemporalOpenAIRunner();
  const result = await runner.run(agent, prompt);
  return result.finalOutput ?? '';
}

/**
 * Workflow whose model returns a tool call for `failingTool` (always-throwing
 * Activity). When the Activity throws, the runner wraps the resulting
 * `ActivityFailure` as a non-retryable `ApplicationFailure` with type
 * `AgentsWorkflowError` (Python parity); the failure is NOT fed back to the
 * agent loop. Test 3 asserts the workflow fails with that classification.
 */
export async function toolFailureWorkflow(prompt: string): Promise<string> {
  const failingDef = activityAsTool<typeof activities.failingTool>(
    {
      name: 'failingTool',
      description: 'A tool that always fails',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: [] as string[],
        additionalProperties: false,
      },
    },
    { retryPolicy: { maximumAttempts: 1 } }
  );

  const agent = new Agent({
    name: 'ToolFailureAgent',
    instructions: 'Call the failing tool.',
    model: 'gpt-4o-mini',
    tools: [failingDef],
  });

  const runner = new TemporalOpenAIRunner();
  const result = await runner.run(agent, prompt, { maxTurns: 3 });
  return result.finalOutput ?? '';
}

/**
 * Workflow that connects to a stateful MCP server whose factory always
 * throws. Test 3 asserts the workflow
 * fails with `ApplicationFailure.type === DEDICATED_WORKER_FAILURE_TYPE`.
 */
export async function brokenStatefulMcpWorkflow(): Promise<string> {
  // Python parity: `connect()` is fire-and-forget. It returns successfully
  // even when the factory throws inside the dedicated-worker session activity.
  // The factory failure only surfaces on the FIRST tool call, when scheduling
  // onto the dead dedicated task queue trips its schedule-to-start timeout,
  // which the integration translates into ApplicationFailure(type='DedicatedWorkerFailure').
  // Override the default 30s schedule-to-start so the test fails fast.
  const server = statefulMcpServer('brokenStatefulMcp', {
    config: { scheduleToStartTimeout: '3s' },
    serverSessionConfig: { startToCloseTimeout: '10s', heartbeatTimeout: '2s' },
  });
  try {
    await server.connect();
    await server.listTools();
    return 'should-not-reach';
  } finally {
    // Best-effort cleanup; may itself fail if the server never connected.
    try {
      await server.cleanup();
    } catch {
      /* ignore */
    }
  }
}
