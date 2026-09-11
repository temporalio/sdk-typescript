/**
 * Scripted `BaseLlm` doubles for the graph / HITL / MCP-resource tests, plus a
 * `modelProvider` that maps model names to them. Like the doubles in
 * `helpers.ts`, every model is rebuilt per Activity, so each derives its turn
 * from the request rather than from instance state.
 */

import { BaseLlm, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';
import type { Content, FunctionResponse } from '@google/genai';

import { defaultTestProvider, ToolCallingLlm } from './helpers';

function functionResponses(llmRequest: LlmRequest): FunctionResponse[] {
  return (llmRequest.contents ?? [])
    .flatMap((content) => content.parts ?? [])
    .map((part) => part.functionResponse)
    .filter((response): response is FunctionResponse => response !== undefined);
}

function textResponse(text: string): LlmResponse {
  return { content: { role: 'model', parts: [{ text }] }, turnComplete: true };
}

/**
 * Drives one gated tool call. Emits the call until a *real* (non-error) result
 * for the tool is in the request, then reports it; a rejection result is
 * reported as `rejected`. Confirmation traffic (`adk_request_confirmation`
 * responses, the "requires confirmation" error result) is ignored, so the
 * model never re-issues the call while the gate is pending.
 */
export class ConfirmationLlm extends BaseLlm {
  private readonly toolName: string;
  private readonly toolArgs: Record<string, unknown>;

  constructor(options: { model: string; toolName: string; toolArgs: Record<string, unknown> }) {
    super({ model: options.model });
    this.toolName = options.toolName;
    this.toolArgs = options.toolArgs;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
    _abortSignal?: AbortSignal
  ): AsyncGenerator<LlmResponse, void> {
    const results = functionResponses(llmRequest).filter((r) => r.name === this.toolName);
    const real = results.find((r) => !(r.response && 'error' in r.response));
    if (real) {
      yield textResponse(`done:${JSON.stringify(real.response)}`);
      return;
    }
    const rejected = results.find(
      (r) => (r.response as { error?: string } | undefined)?.error === 'This tool call is rejected.'
    );
    if (rejected) {
      yield textResponse('rejected');
      return;
    }
    if (results.length > 0) {
      // The gate is pending; ADK skips summarization, so this is not reached in
      // practice, but never loop on the call.
      yield textResponse('pending');
      return;
    }
    yield {
      content: { role: 'model', parts: [{ functionCall: { name: this.toolName, args: this.toolArgs } }] },
      turnComplete: true,
    };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('ConfirmationLlm does not connect.');
  }
}

/**
 * Drives ADK's `requestInputTool` on a plain agent: asks for the user's name
 * until a user text other than the opening prompt is in the request, then
 * reports it. (ADK removes the framework call and its response from the
 * model's context, so the answer can only arrive as text.)
 */
export class RequestInputLlm extends BaseLlm {
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
    _abortSignal?: AbortSignal
  ): AsyncGenerator<LlmResponse, void> {
    const userTexts = (llmRequest.contents ?? [])
      .filter((c) => c.role === 'user')
      .flatMap((c) => c.parts ?? [])
      .map((p) => p.text)
      .filter((t): t is string => typeof t === 'string');
    const answer = userTexts.find((t) => t !== 'start');
    if (answer !== undefined) {
      yield textResponse(`name=${answer}`);
      return;
    }
    yield {
      content: {
        role: 'model',
        parts: [{ functionCall: { name: 'adk_request_input', args: { message: 'Your name?' } } }],
      },
      turnComplete: true,
    };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('RequestInputLlm does not connect.');
  }
}

/**
 * Drives ADK's two-phase `load_mcp_resource` tool: first turn asks for the
 * `readme` resource; the turn after reports the resource contents the tool
 * appended to the request (`Resource readme is:` followed by the text part) and
 * the instruction listing the available resources.
 */
export class ResourceLlm extends BaseLlm {
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
    _abortSignal?: AbortSignal
  ): AsyncGenerator<LlmResponse, void> {
    const asked = functionResponses(llmRequest).some((r) => r.name === 'load_mcp_resource');
    if (!asked) {
      yield {
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'load_mcp_resource', args: { resource_names: ['readme'] } } }],
        },
        turnComplete: true,
      };
      return;
    }
    const contents: Content[] = llmRequest.contents ?? [];
    const marker = contents.findIndex((c) => c.role === 'user' && c.parts?.[0]?.text === 'Resource readme is:');
    const resourceText = marker === -1 ? undefined : contents[marker]?.parts?.[1]?.text;
    const instruction = String(llmRequest.config?.systemInstruction ?? '');
    const listed = /You have a list of MCP resources:\n(\[[^\]]*\])/.exec(instruction)?.[1];
    yield textResponse(`resource=${resourceText ?? 'missing'}; listed=${listed ?? 'none'}`);
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('ResourceLlm does not connect.');
  }
}

/**
 * The `modelProvider` for the graph / HITL / resource suites. Names encode the
 * scenario; everything else falls through to {@link defaultTestProvider}.
 */
export function graphTestProvider(): (model: string) => BaseLlm {
  const fallback = defaultTestProvider();
  return (model: string): BaseLlm => {
    switch (model) {
      case 'finish-task-model':
        return new ToolCallingLlm({ model, toolName: 'finish_task', toolArgs: { result: 'task-done' } });
      case 'enrich-flow-model':
        return new ToolCallingLlm({ model, toolName: 'enrich_flow', toolArgs: { value: 7 } });
      case 'enrich-flow-genai-model':
        return new ToolCallingLlm({ model, toolName: 'enrich_flow', toolArgs: { request: '7' } });
      case 'request-input-model':
        return new RequestInputLlm({ model });
      case 'confirm-danger-model':
        return new ConfirmationLlm({ model, toolName: 'dangerActivity', toolArgs: { target: 'prod' } });
      case 'confirm-echo-model':
        return new ConfirmationLlm({ model, toolName: 'echo', toolArgs: { value: 'hello' } });
      case 'confirm-gate-model':
        return new ConfirmationLlm({ model, toolName: 'dynamicGate', toolArgs: { target: 'prod' } });
      case 'resource-model':
        return new ResourceLlm({ model });
      default:
        return fallback(model);
    }
  };
}
