/**
 * Scripted `BaseLlm` doubles for the graph / dynamic tests, plus a
 * `modelProvider` that maps model names to them. Like the doubles in
 * `helpers.ts`, every model is rebuilt per Activity, so each derives its turn
 * from the request rather than from instance state.
 */

import { BaseLlm, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';

import { defaultTestProvider, ToolCallingLlm } from './helpers';

/**
 * A model that answers with the number of `contents` its request carried, so a test can
 * witness what a context compactor removed from the history the agent sends.
 */
class ContentsCountingLlm extends BaseLlm {
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
    _abortSignal?: AbortSignal
  ): AsyncGenerator<LlmResponse, void> {
    yield {
      content: { role: 'model', parts: [{ text: `contents:${(llmRequest.contents ?? []).length}` }] },
      turnComplete: true,
    };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('ContentsCountingLlm does not connect.');
  }
}

/**
 * Fails its first call with an HTTP 400 and succeeds on every later one. The counter lives
 * in the provider closure, not on the model, because the plugin rebuilds a model per
 * Activity; from the Workflow's side the sequence is still fail-then-succeed, and the
 * Activity runs once per attempt however often the Workflow replays.
 */
class FailFirstLlm extends BaseLlm {
  private readonly calls: { count: number };

  constructor(options: { model: string; calls: { count: number } }) {
    super({ model: options.model });
    this.calls = options.calls;
  }

  override async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
    _abortSignal?: AbortSignal
  ): AsyncGenerator<LlmResponse, void> {
    this.calls.count += 1;
    if (this.calls.count === 1) {
      throw Object.assign(new Error('bad request'), { status: 400 });
    }
    yield {
      content: { role: 'model', parts: [{ text: `recovered-on-attempt-${this.calls.count}` }] },
      turnComplete: true,
    };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('FailFirstLlm does not connect.');
  }
}

/**
 * The `modelProvider` for the graph / dynamic suites. Names encode the
 * scenario; everything else falls through to {@link defaultTestProvider}.
 */
export function graphTestProvider(): (model: string) => BaseLlm {
  const fallback = defaultTestProvider();
  const failFirstCalls = { count: 0 };
  return (model: string): BaseLlm => {
    switch (model) {
      case 'fail-first-model':
        return new FailFirstLlm({ model, calls: failFirstCalls });
      case 'finish-task-model':
        return new ToolCallingLlm({ model, toolName: 'finish_task', toolArgs: { result: 'task-done' } });
      case 'enrich-flow-model':
        return new ToolCallingLlm({ model, toolName: 'enrich_flow', toolArgs: { value: 7 } });
      case 'enrich-flow-genai-model':
        return new ToolCallingLlm({ model, toolName: 'enrich_flow', toolArgs: { request: '7' } });
      case 'contents-counting-model':
        return new ContentsCountingLlm({ model });
      default:
        return fallback(model);
    }
  };
}
