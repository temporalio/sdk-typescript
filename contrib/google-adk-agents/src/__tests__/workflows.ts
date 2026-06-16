/**
 * Workflow definitions used by the E2E tests. These run inside the Temporal
 * Workflow sandbox: they construct real `@google/adk` objects (the ADK
 * `BaseLlm` subclass `TemporalModel`, `BaseToolset` subclass `TemporalMcpToolSet`,
 * `LongRunningFunctionTool`) and invoke their native entry points. The plugin
 * routes the model/MCP I/O to Activities.
 */

import {
  InMemoryRunner,
  isFinalResponse,
  LlmAgent,
  LongRunningFunctionTool,
  stringifyContent,
  type LlmRequest,
} from '@google/adk';
import type { Duration } from '@temporalio/common';
import { condition, defineSignal, defineUpdate, setHandler } from '@temporalio/workflow';

import { TemporalModel, TemporalMcpToolSet, activityAsTool } from '../index.js';

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

/** A model call with a custom summary set on the Activity. */
export async function modelCallWithSummary(prompt: string): Promise<string> {
  const llm = new TemporalModel('fake-model', { summary: 'custom-model-summary' });
  let text = '';
  for await (const response of llm.generateContentAsync(makeRequest(prompt))) {
    text += collectText(response.content?.parts);
  }
  return text;
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

/** A streaming model call with no `streamingTopic` configured (must fail). */
export async function streamingModelCallNoTopic(): Promise<string> {
  const llm = new TemporalModel('fake-model');
  let text = '';
  for await (const response of llm.generateContentAsync(makeRequest('stream please'), true)) {
    text += collectText(response.content?.parts);
  }
  return text;
}

/** Discover MCP tools and assert the full schema crossed the boundary. */
export async function mcpListTools(): Promise<{
  count: number;
  firstName: string;
  hasParameters: boolean;
}> {
  const toolset = new TemporalMcpToolSet({ name: 'testServer' });
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
  const toolset = new TemporalMcpToolSet({ name: 'testServer' });
  const tools = await toolset.getTools();
  const tool = tools.find((t) => t.name === 'echo');
  if (!tool) {
    throw new Error('echo tool not found');
  }
  return tool.runAsync({ args: { value }, toolContext: {} as never });
}

/** MCP discovery with a toolFilter restricting to a subset of tools. */
export async function mcpFilteredTools(): Promise<string[]> {
  const toolset = new TemporalMcpToolSet({ name: 'testServer', toolFilter: ['echo'] });
  const tools = await toolset.getTools();
  return tools.map((t) => t.name);
}

/** Dispatch a registered Temporal Activity as an ADK tool. */
export async function activityToolCall(orderId: string): Promise<unknown> {
  const tool = activityAsTool({
    name: 'lookupOrder',
    description: 'Look up an order by id.',
  });
  return tool.runAsync({ args: { orderId }, toolContext: {} as never });
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
 * by an MCP tool discovery + call. Produces a history with `invokeModel` ×2,
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

  const toolset = new TemporalMcpToolSet({ name: 'testServer' });
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
 * the runner makes through the `invokeModel` Activity, so durability requires
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
