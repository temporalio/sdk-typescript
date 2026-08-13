/**
 * Workflow definitions used by the E2E tests. These run inside the Temporal
 * Workflow sandbox: they construct real `@google/adk` objects (the ADK
 * `BaseLlm` subclass `TemporalModel`, `BaseToolset` subclass `TemporalMCPToolset`,
 * `LongRunningFunctionTool`) and invoke their native entry points. The plugin
 * routes the model/MCP I/O to Activities.
 */

// In the Workflow bundle this resolves to the plugin's deterministic `net`
// shim; on the worker (test files import this module for workflow references)
// it is the real builtin.
import { isIP } from 'node:net';

import {
  InMemoryRunner,
  isFinalResponse,
  LlmAgent,
  LongRunningFunctionTool,
  stringifyContent,
  type LlmRequest,
} from '@google/adk';
import { Type } from '@google/genai';
import type { Duration } from '@temporalio/common';
import { condition, defineSignal, defineUpdate, proxyActivities, setHandler } from '@temporalio/workflow';
import { WorkflowStream } from '@temporalio/workflow-streams/workflow';

import { TemporalModel, TemporalMCPToolset, activityAsTool, type TemporalMCPToolsetOptions } from '../workflow';

// Mirrors `@google/adk` >= 1.5.0 `tools/load_web_page.js` (on the barrel
// path), which parses its blocked-CIDR tables at module load, calling
// `net.isIP` in the process. Keeping the same top-level shape here makes every
// E2E bundle in this suite fail at Workflow load if the `net` shim regresses.
const BLOCKED_IPV6_CIDR_BASES = ['::', '::1', '64:ff9b:1::', '100::', '2001:db8::', 'fc00::', 'fe80::', 'ff00::'];
const blockedIpv6BaseVersions = BLOCKED_IPV6_CIDR_BASES.map((address) => isIP(address));

/** Build a minimal, serializable LlmRequest for a single user turn. */
function makeRequest(text: string): LlmRequest {
  return {
    model: 'fake-model',
    contents: [{ role: 'user', parts: [{ text }] }],
    config: {},
    toolsDict: {},
    liveConnectConfig: {},
  } as LlmRequest;
}

function collectText(parts: Array<{ text?: string }> | undefined): string {
  let text = '';
  for (const part of parts ?? []) {
    if (part.text) text += part.text;
  }
  return text;
}

/** One model call through the plugin; returns the concatenated text. */
export async function singleModelCall(prompt: string): Promise<string> {
  const llm = new TemporalModel('fake-model');
  let text = '';
  for await (const response of llm.generateContentAsync(makeRequest(prompt))) {
    text += collectText(response.content?.parts);
  }
  return text;
}

/** N sequential model calls; returns how many responses were produced. */
export async function countModelCalls(n: number): Promise<number> {
  const llm = new TemporalModel('fake-model');
  let responses = 0;
  for (let i = 0; i < n; i++) {
    for await (const _response of llm.generateContentAsync(makeRequest(`turn-${i}`))) {
      responses++;
    }
  }
  return responses;
}

/** A model call with a very short timeout against a deliberately slow model. */
export async function modelCallWithTimeout(): Promise<string> {
  // `maximumAttempts: 1` so the start-to-close timeout fails the Workflow on the
  // first attempt instead of retrying forever.
  const llm = new TemporalModel('slow-model', {
    activity: {
      startToCloseTimeout: '1 second',
      retry: { maximumAttempts: 1 },
    },
  });
  let text = '';
  for await (const response of llm.generateContentAsync(makeRequest('hi'))) {
    text += collectText(response.content?.parts);
  }
  return text;
}

/** A model call whose backing model raises a non-retryable (4xx) error. */
export async function modelCallError(): Promise<string> {
  const llm = new TemporalModel('boom', { activity: { retry: { maximumAttempts: 1 } } });
  let text = '';
  for await (const response of llm.generateContentAsync(makeRequest('explode'))) {
    text += collectText(response.content?.parts);
  }
  return text;
}

/**
 * Sequential model calls covering every `summary` resolution branch, in this
 * order: a top-level string, `activity.summary` alone, neither (the generic
 * auto-generated label), and both set (the top-level string wins). Returns the
 * number of responses produced.
 */
export async function modelCallsWithSummaryVariants(): Promise<number> {
  const models = [
    new TemporalModel('fake-model', { summary: 'custom-model-summary' }),
    new TemporalModel('fake-model', { activity: { summary: 'activity-summary' } }),
    new TemporalModel('fake-model'),
    new TemporalModel('fake-model', { summary: 'top-level-summary', activity: { summary: 'activity-summary' } }),
  ];
  let responses = 0;
  for (const llm of models) {
    for await (const _response of llm.generateContentAsync(makeRequest('hi'))) {
      responses++;
    }
  }
  return responses;
}

/** Streaming (SSE) model call; returns concatenated chunk text + chunk count. */
export async function streamingModelCall(
  batchInterval: Duration = '50 milliseconds'
): Promise<{ text: string; chunks: number }> {
  const llm = new TemporalModel('fake-model', {
    streamingTopic: 'adk-test-stream',
    streamingBatchInterval: batchInterval,
    activity: { heartbeatTimeout: '5 seconds' },
  });
  let text = '';
  let chunks = 0;
  for await (const response of llm.generateContentAsync(makeRequest('stream please'), true)) {
    text += collectText(response.content?.parts);
    chunks++;
  }
  return { text, chunks };
}

export const closeStream = defineSignal('closeStream');

/**
 * Streaming model call that hosts a `WorkflowStream` and stays alive until
 * `closeStream`, so an external subscriber can drain the published chunks.
 */
export async function streamingModelCallSubscribed(
  batchInterval?: Duration
): Promise<{ text: string; chunks: number }> {
  new WorkflowStream();
  let closed = false;
  setHandler(closeStream, () => {
    closed = true;
  });
  const out = await streamingModelCall(batchInterval);
  await condition(() => closed);
  return out;
}

/** A streaming model call with no `streamingTopic` configured (must fail). */
export async function streamingModelCallNoTopic(): Promise<string> {
  const llm = new TemporalModel('fake-model');
  let text = '';
  for await (const response of llm.generateContentAsync(makeRequest('stream please'), true)) {
    text += collectText(response.content?.parts);
  }
  return text;
}

/** Attempt a BIDI live connection inside the Workflow (must fail). */
export async function modelConnectInWorkflow(): Promise<string> {
  const llm = new TemporalModel('fake-model');
  await llm.connect(makeRequest('hi'));
  return 'unreachable';
}

/** Discover MCP tools and assert the full schema crossed the boundary. */
export async function mcpListTools(): Promise<{
  count: number;
  firstName: string;
  hasParameters: boolean;
}> {
  const toolset = new TemporalMCPToolset({ name: 'testServer' });
  const tools = await toolset.getTools();
  const first = tools[0];
  const declaration = first?._getDeclaration();
  return {
    count: tools.length,
    firstName: first?.name ?? '',
    hasParameters: declaration?.parameters !== undefined,
  };
}

/** Call an MCP tool through the plugin; returns the tool result. */
export async function mcpCallTool(value: string): Promise<unknown> {
  const toolset = new TemporalMCPToolset({ name: 'testServer' });
  const tools = await toolset.getTools();
  const tool = tools.find((t) => t.name === 'echo');
  if (!tool) {
    throw new Error('echo tool not found');
  }
  return tool.runAsync({ args: { value }, toolContext: {} as never });
}

/**
 * Calls the `testServer-callTool` Activity directly with a tool name the server
 * does not expose, exercising the Activity-side not-found path.
 */
export async function mcpCallUnknownTool(): Promise<unknown> {
  const activities = proxyActivities<{
    'testServer-callTool': (args: { toolName: string; args: Record<string, unknown> }) => Promise<unknown>;
  }>({
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 1 },
  });
  return activities['testServer-callTool']({ toolName: 'does-not-exist', args: {} });
}

/** MCP discovery + tool call with a caller-supplied `activity.summary`. */
export async function mcpCallToolWithActivitySummary(value: string): Promise<unknown> {
  const toolset = new TemporalMCPToolset({
    name: 'testServer',
    activity: { summary: 'mcp-activity-summary' },
  });
  const tools = await toolset.getTools();
  const tool = tools.find((t) => t.name === 'echo');
  if (!tool) {
    throw new Error('echo tool not found');
  }
  return tool.runAsync({ args: { value }, toolContext: {} as never });
}

/**
 * MCP discovery under the three ways a toolset can reshape the advertised tool
 * names: a `toolFilter`, a `prefix`, and both at once. Returns the advertised
 * names each configuration produced.
 */
export async function mcpToolNameVariants(): Promise<{ filtered: string[]; prefixed: string[]; both: string[] }> {
  async function advertisedNames(options: TemporalMCPToolsetOptions): Promise<string[]> {
    const toolset = new TemporalMCPToolset(options);
    const tools = await toolset.getTools();
    return tools.map((t) => t.name);
  }
  return {
    filtered: await advertisedNames({ name: 'testServer', toolFilter: ['echo'] }),
    prefixed: await advertisedNames({ name: 'testServer', prefix: 'srv' }),
    both: await advertisedNames({ name: 'testServer', toolFilter: ['srv_echo'], prefix: 'srv' }),
  };
}

/**
 * The plugin's central use case: an ordinary ADK agent whose only tool is a
 * registered Temporal Activity, driven by the SDK's own runner. The model's
 * first turn emits a `functionCall`, ADK dispatches it through
 * {@link activityAsTool} — one Activity — and the runner appends the result to
 * the session so a second model turn sees it. Returns that turn's text.
 */
export async function agentToolLoopWorkflow(prompt: string): Promise<string> {
  const agent = new LlmAgent({
    name: 'assistant',
    model: new TemporalModel('fake-model'),
    instruction: 'You are a helpful assistant.',
    tools: [
      activityAsTool({
        name: 'lookupOrder',
        description: 'Look up an order by id.',
        parameters: {
          type: Type.OBJECT,
          properties: { orderId: { type: Type.STRING, description: 'The order to look up.' } },
          required: ['orderId'],
        },
      }),
    ],
  });
  const runner = new InMemoryRunner({ agent });

  let finalText = '';
  for await (const event of runner.runEphemeral({
    userId: 'test-user',
    newMessage: { role: 'user', parts: [{ text: prompt }] },
  })) {
    if (isFinalResponse(event)) {
      finalText = stringifyContent(event);
    }
  }
  return finalText;
}

export const approveSignal = defineSignal<[string]>('approve');
export const approveUpdate = defineUpdate<string, [string]>('approveUpdate');

/**
 * HITL: a `LongRunningFunctionTool` whose `execute` (running in the Workflow
 * body) awaits a Temporal Signal or Update carrying the human's result.
 */
export async function hitlWorkflow(): Promise<string> {
  let result: string | undefined;
  setHandler(approveSignal, (value) => {
    result = value;
  });
  setHandler(approveUpdate, (value) => {
    result = value;
    return value;
  });

  const tool = new LongRunningFunctionTool({
    name: 'humanApproval',
    description: 'Wait for a human approval.',
    execute: async () => {
      await condition(() => result !== undefined);
      return result;
    },
  });

  const out = await tool.runAsync({ args: {}, toolContext: {} as never });
  return out as string;
}

/**
 * A combined scenario for the replay test: two sequential model calls followed
 * by an MCP tool discovery + call. Produces a history with `adk-invokeModel` ×2,
 * `testServer-listTools`, and `testServer-callTool` so replay exercises both
 * boundaries against a single recorded history.
 */
export async function replayScenario(): Promise<string> {
  const llm = new TemporalModel('fake-model');
  let text = '';
  for (let i = 0; i < 2; i++) {
    for await (const response of llm.generateContentAsync(makeRequest(`turn-${i}`))) {
      text += collectText(response.content?.parts);
    }
  }

  const toolset = new TemporalMCPToolset({ name: 'testServer' });
  const tools = await toolset.getTools();
  const echo = tools.find((t) => t.name === 'echo');
  if (echo) {
    const out = (await echo.runAsync({
      args: { value: 'world' },
      toolContext: {} as never,
    })) as { echoed?: string };
    text += out.echoed ?? '';
  }
  return text;
}

/**
 * Native ADK integration: build a real `LlmAgent` whose model is a
 * `TemporalModel`, then drive it with the SDK's own `InMemoryRunner.runEphemeral`
 * loop inside the Workflow and return the agent's final text response. The user
 * writes ordinary ADK code — the plugin transparently routes every model turn
 * the runner makes through the `adk-invokeModel` Activity, so durability requires
 * no rewrite of the agent or the runner.
 */
export async function agentRunnerWorkflow(prompt: string): Promise<string> {
  const agent = new LlmAgent({
    name: 'assistant',
    model: new TemporalModel('fake-model'),
    instruction: 'You are a helpful assistant.',
  });
  const runner = new InMemoryRunner({ agent });

  let finalText = '';
  for await (const event of runner.runEphemeral({
    userId: 'test-user',
    newMessage: { role: 'user', parts: [{ text: prompt }] },
  })) {
    if (isFinalResponse(event)) {
      finalText = stringifyContent(event);
    }
  }
  return finalText;
}

/**
 * Two sequential agent turns through the native runner loop, for the telemetry
 * test. Produces a history with two `adk-invokeModel` Activities across three
 * (or more) workflow tasks — so a cache-disabled worker replays the first
 * turn's code on later tasks, while ADK's spans must be exported exactly once
 * per real turn.
 */
export async function agentRunnerTwoTurnsWorkflow(prompt: string): Promise<string> {
  const agent = new LlmAgent({
    name: 'assistant',
    model: new TemporalModel('fake-model'),
    instruction: 'You are a helpful assistant.',
  });
  const runner = new InMemoryRunner({ agent });

  const texts: string[] = [];
  for (let turn = 0; turn < 2; turn++) {
    for await (const event of runner.runEphemeral({
      userId: 'test-user',
      newMessage: { role: 'user', parts: [{ text: `${prompt}-${turn}` }] },
    })) {
      if (isFinalResponse(event)) {
        texts.push(stringifyContent(event));
      }
    }
  }
  return texts.join('|');
}

/** `net` shim classifications computed at module load and at run time. */
export async function netShimProbe(): Promise<{ loadTime: number[]; runtime: number[] }> {
  return {
    loadTime: blockedIpv6BaseVersions,
    runtime: ['127.0.0.1', '::ffff:127.0.0.1', 'not-an-ip'].map((address) => isIP(address)),
  };
}
