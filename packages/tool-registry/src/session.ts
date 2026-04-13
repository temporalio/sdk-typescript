/**
 * agenticSession — durable multi-turn LLM activity with heartbeat checkpointing.
 *
 * Provides {@link agenticSession}, a function that saves conversation state via
 * {@link heartbeat} from `@temporalio/activity` after each LLM turn. On activity
 * retry, the session is automatically restored from the last checkpoint so the
 * conversation resumes mid-turn rather than restarting from the beginning.
 *
 * This builds on standard Temporal APIs — `activity.heartbeat()` and
 * `Context.current().info.heartbeatDetails` — and adds conversation-specific
 * serialization and restore logic as a reusable primitive.
 *
 * TypeScript uses a callback pattern rather than Python's `async with` because
 * TypeScript lacks a direct equivalent of async context managers for yielding
 * mutable objects. The behaviour is identical:
 *
 * ```
 * Python:     async with agentic_session() as session: ...
 * TypeScript: await agenticSession(async (session) => { ... })
 * ```
 *
 * @example
 * ```typescript
 * import { activityDefn } from '@temporalio/activity';
 * import { ToolRegistry, agenticSession } from '@temporalio/tool-registry';
 *
 * export async function analyze(prompt: string): Promise<object[]> {
 *   let results: object[] = [];
 *   await agenticSession(async (session) => {
 *     results = session.results;
 *     const tools = new ToolRegistry();
 *     tools.define(
 *       { name: 'flag', description: '...', input_schema: { ... } },
 *       (inp) => { session.results.push(inp); return 'recorded'; }
 *     );
 *     await session.runToolLoop({
 *       registry: tools,
 *       provider: 'anthropic',
 *       system: '...',
 *       prompt,
 *     });
 *   });
 *   return results;
 * }
 * ```
 */

import { activityInfo, heartbeat, ApplicationFailure } from '@temporalio/activity';
import type { ToolRegistry } from './registry';

/** Saved checkpoint state serialized by {@link AgenticSession._checkpoint}. */
interface CheckpointState {
  version?: number;
  messages: unknown[];
  results: unknown[];
}

/** Options for {@link AgenticSession.runToolLoop}. */
export interface RunToolLoopOptions {
  /** Tool registry with handlers for all tools the model may call. */
  registry: ToolRegistry;
  /** LLM provider: `"anthropic"` or `"openai"`. */
  provider: string;
  /** System prompt. */
  system: string;
  /** Initial user message. Ignored on resume (messages already set). */
  prompt: string;
  /** Model name override. Uses provider default if omitted. */
  model?: string;
  /** Pre-constructed LLM client. Useful in tests to avoid API key requirements. */
  client?: unknown;
}

/**
 * Holds conversation state across a multi-turn LLM tool-use loop.
 *
 * Instances are created by {@link agenticSession} and should not normally be
 * constructed directly. On activity retry, {@link agenticSession} deserializes
 * the saved state from `activityInfo().heartbeatDetails` and passes it to the
 * constructor.
 */
export class AgenticSession {
  /** Full conversation history in provider-neutral format. */
  messages: unknown[];
  /** Application-level results accumulated during the session. */
  results: unknown[];

  constructor(state: Partial<CheckpointState> = {}) {
    this.messages = state.messages ?? [];
    this.results = state.results ?? [];
  }

  /**
   * Run the agentic tool-use loop to completion.
   *
   * If {@link messages} is empty (fresh start), adds `prompt` as the first
   * user message. Otherwise resumes from the existing conversation state
   * (retry case).
   *
   * Checkpoints via {@link _checkpoint} before each LLM call. If the activity
   * is cancelled due to a heartbeat timeout, the next attempt will restore from
   * the last checkpoint.
   *
   * @throws {Error} If `provider` is not `"anthropic"` or `"openai"`.
   */
  async runToolLoop(opts: RunToolLoopOptions): Promise<void> {
    const { registry, provider, system, prompt, model, client } = opts;

    if (this.messages.length === 0) {
      this.messages = [{ role: 'user', content: prompt }];
    }

    const providerOpts = { model, client };

    if (provider === 'anthropic') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AnthropicProvider } = require('./providers') as typeof import('./providers');
      const p = new AnthropicProvider(registry, system, providerOpts);
      while (true) {
        this._checkpoint();
        const done = await p.runTurn(this.messages as Array<Record<string, unknown>>);
        if (done) break;
      }
    } else if (provider === 'openai') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { OpenAIProvider } = require('./providers') as typeof import('./providers');
      const p = new OpenAIProvider(registry, system, providerOpts);
      while (true) {
        this._checkpoint();
        const done = await p.runTurn(this.messages as Array<Record<string, unknown>>);
        if (done) break;
      }
    } else {
      throw new Error(`Unknown provider ${JSON.stringify(provider)}. Use 'anthropic' or 'openai'.`);
    }
  }

  /**
   * Heartbeat the serialized conversation state for crash-safe resume.
   *
   * `heartbeat()` from `@temporalio/activity` persists the payload to the
   * Temporal server. On retry, `activityInfo().heartbeatDetails[0]` contains
   * this JSON. {@link agenticSession} reads it on entry and restores
   * messages + issues.
   *
   * @throws {ApplicationFailure} (non-retryable) If any result is not JSON-serializable.
   * @internal
   */
  _checkpoint(): void {
    for (let i = 0; i < this.results.length; i++) {
      try {
        JSON.stringify(this.results[i]);
      } catch (e) {
        throw ApplicationFailure.nonRetryable(
          `AgenticSession: results[${i}] is not JSON-serializable: ${e}. ` +
            'Store only plain objects with JSON-serializable values.',
        );
      }
    }
    heartbeat(JSON.stringify({ version: 1, messages: this.messages, results: this.results }));
  }
}

/**
 * Run a callback with a durable, checkpointed LLM session.
 *
 * On entry, restores conversation state (messages + issues) from
 * `activityInfo().heartbeatDetails` if this is a retry. The session resumes
 * mid-conversation instead of restarting from turn 0.
 *
 * @param fn - Async callback that receives the session and runs the tool loop.
 * @returns The return value of `fn`.
 *
 * @example
 * ```typescript
 * const result = await agenticSession(async (session) => {
 *   await session.runToolLoop({ registry, provider: 'anthropic', system, prompt });
 *   return session.results;
 * });
 * ```
 */
export async function agenticSession<T>(
  fn: (session: AgenticSession) => Promise<T>
): Promise<T> {
  const details = activityInfo().heartbeatDetails as unknown[];
  let saved: Partial<CheckpointState> = {};

  if (details && details.length > 0) {
    try {
      saved = JSON.parse(details[0] as string) as CheckpointState;
      const v = saved.version;
      if (v === undefined || v === null) {
        // eslint-disable-next-line no-console
        console.warn('AgenticSession: checkpoint has no version field — may be from an older release');
      } else if (v !== 1) {
        // eslint-disable-next-line no-console
        console.warn(`AgenticSession: checkpoint version ${v}, expected 1 — starting fresh`);
        saved = {} as CheckpointState;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`AgenticSession: failed to decode checkpoint, starting fresh: ${e}`);
    }
  }

  const session = new AgenticSession(saved);
  return fn(session);
}
