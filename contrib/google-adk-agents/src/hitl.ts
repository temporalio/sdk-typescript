/**
 * Wire-format helpers for durable human-in-the-loop (HITL) with ADK 2.0.
 *
 * ADK pauses a run by emitting a long-running function call named
 * `adk_request_input` (a `RequestInput` node, `requestInputTool`,
 * `getUserChoiceTool`) or `adk_request_confirmation` (a tool gated with
 * `requireConfirmation`), and resumes when a later **user** message carries a
 * `functionResponse` with the same `id` and `name`. Because the ADK runner
 * runs inside the Workflow, the wait itself is ordinary Workflow code:
 *
 * ```ts
 * // 1. expose what is pending
 * setHandler(pendingQuery, () => pendingHitlRequests(events));
 * // 2. take the human's answer through a Signal or Update
 * setHandler(respondUpdate, (interruptId, value) => { answers.set(interruptId, value); });
 * // 3. wait durably, then run the next turn with the answers
 * await condition(() => pending.every((r) => answers.has(r.interruptId)));
 * const parts = pending.map((r) => hitlInputResponse(r, answers.get(r.interruptId)));
 * for await (const event of runner.runAsync({ userId, sessionId, newMessage: { role: 'user', parts } })) { … }
 * ```
 *
 * These helpers cover the wire format only. Credential requests
 * (`adk_request_credential`) are deliberately excluded: answering one means
 * sending a secret through a Signal/Update payload that is persisted in
 * Workflow history, and the plugin's deterministic id generation makes ADK's
 * OAuth2 `state` parameter predictable inside a Workflow. Acquire credentials
 * worker-side (an Activity, an MCP toolset factory) instead.
 *
 * Pure functions: usable in Workflow code and in the Client that drives the
 * Signal/Update.
 */

import type { Part } from '@google/genai';
import {
  getPendingUserInputRequests,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  type Event,
  type UserInputRequest,
} from '@google/adk';

/**
 * A pause awaiting a human answer: ADK's own {@link UserInputRequest}, plain
 * JSON, so a Workflow Query can return it as-is. `kind` is `'input'` or
 * `'confirmation'` here — see {@link pendingHitlRequests}.
 */
export type HitlRequest = UserInputRequest;

/** The human's decision for a tool gated with `requireConfirmation`. */
export interface HitlConfirmation {
  /** Approve (`true`) or reject the call. ADK tests `=== true`, so nothing else approves. */
  confirmed: boolean;
  /** Optional echo of the hint shown to the human. */
  hint?: string;
  /** Optional data the tool reads from `toolContext.toolConfirmation.payload`. */
  payload?: unknown;
}

/**
 * The pauses in `events` that still await an answer, excluding credential
 * requests (see the module doc). Pass the session's events, collected from the
 * `runAsync` iteration or read from `runner.sessionService.getSession(...)`.
 *
 * This wraps ADK's `getPendingUserInputRequests`, whose bookkeeping is coarser
 * than it looks: a request counts as answered as soon as *any* `functionResponse`
 * anywhere in `events` carries its id, whoever authored it and whether or not
 * ADK went on to accept it (a reply its `responseSchema` refuses leaves the run
 * paused but drops it from this list). The converse also holds: an answer that
 * is not a function response never clears it, so a plain-text gate approval
 * (`runConfig.plainTextToolConfirmation`) and a text reply to an agent's own
 * `requestInputTool` both keep being listed. A driver loop that uses those has
 * to remember what it already answered.
 */
export function pendingHitlRequests(events: readonly Event[]): HitlRequest[] {
  return getPendingUserInputRequests(events).filter((request) => request.kind !== 'credential');
}

/**
 * Builds the `Part` answering an input request (`adk_request_input`). Put it
 * in the next turn's `newMessage` as `{ role: 'user', parts: [part] }`.
 *
 * A plain object `value` is sent as-is, so it can satisfy the request's
 * `responseSchema`; anything else is wrapped in the `{ result: value }`
 * envelope ADK unwraps. The unwrap is by shape, not by who wrote it: ADK
 * delivers the bare value of any response whose single key is `result`, so a
 * `value` of `{ result: x }` reaches the node as `x`.
 *
 * ADK also parses a **string** it unwraps as JSON, unless the request declared
 * a schema that accepts strings (`type: 'string'`), so `'42'` or `'true'` would
 * reach the node as a number or a boolean. Rather than let that happen
 * silently, this throws: declare a string `responseSchema` on the
 * `RequestInput`, or pass the parsed value yourself.
 */
export function hitlInputResponse(request: HitlRequest, value: unknown): Part {
  assertKind(request, 'input', 'hitlInputResponse');
  const response = isPlainObject(value) ? value : { result: value };
  assertNoJsonCoercion(request, response);
  return {
    functionResponse: {
      id: request.interruptId,
      name: request.functionCallName || REQUEST_INPUT_FUNCTION_CALL_NAME,
      response,
    },
  };
}

/**
 * Builds the `Part` answering a tool-confirmation request
 * (`adk_request_confirmation`). ADK reads approvals from the **latest**
 * user-authored event only, so answer every pending confirmation in one
 * `newMessage`, and rebuild the agent for the resumed turn with the same tool
 * names — an approval naming a tool the agent no longer has is refused.
 */
export function hitlConfirmationResponse(request: HitlRequest, decision: HitlConfirmation): Part {
  assertKind(request, 'confirmation', 'hitlConfirmationResponse');
  const response: Record<string, unknown> = { confirmed: decision.confirmed === true };
  if (decision.hint !== undefined) response.hint = decision.hint;
  if (decision.payload !== undefined) response.payload = decision.payload;
  return {
    functionResponse: {
      id: request.interruptId,
      name: request.functionCallName || REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
      response,
    },
  };
}

function assertKind(request: HitlRequest, kind: HitlRequest['kind'], helper: string): void {
  if (request.kind !== kind) {
    throw new TypeError(
      `${helper}: interrupt '${request.interruptId}' has kind '${request.kind}', not '${kind}'. ` +
        (request.kind === 'credential'
          ? 'Credential requests are not answerable from a Workflow; acquire credentials worker-side.'
          : `Use ${kind === 'input' ? 'hitlConfirmationResponse' : 'hitlInputResponse'} for it.`)
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a JSON schema accepts a plain string — the same rule as ADK's
 * `acceptsString` (`workflow/utils/rehydration_utils.ts`): a `string` type, a
 * type list containing it, or an `anyOf`/`oneOf` branch that does. An absent
 * or unreadable schema accepts nothing, so ADK parses.
 */
function acceptsString(schema: unknown): boolean {
  if (!isPlainObject(schema)) return false;
  const type = schema['type'];
  if (type === 'string') return true;
  if (Array.isArray(type) && type.includes('string')) return true;
  for (const key of ['anyOf', 'oneOf']) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.some(acceptsString)) return true;
  }
  return false;
}

/**
 * Refuses a response whose text ADK would retype on the way in. Applies the
 * same two steps as ADK's `unwrapResponse`
 * (`workflow/utils/rehydration_utils.ts`): unwrap a response whose only key is
 * `result`, then JSON-parse a string the declared schema does not accept.
 */
function assertNoJsonCoercion(request: HitlRequest, response: Record<string, unknown>): void {
  if (Object.keys(response).length !== 1 || !(RESULT_KEY in response)) return;
  const unwrapped = response[RESULT_KEY];
  if (typeof unwrapped !== 'string' || acceptsString(request.responseSchema)) return;
  const parsed = parseJsonIfPossible(unwrapped);
  if (parsed === NOT_JSON || typeof parsed === 'string') return;
  throw new TypeError(
    `hitlInputResponse: the string ${JSON.stringify(unwrapped)} answering interrupt '${request.interruptId}' ` +
      `would be delivered to the node as JSON (${typeof parsed}), because the request declared no ` +
      'schema accepting a string. Declare a string responseSchema on the RequestInput, or pass the ' +
      'parsed value instead of the string.'
  );
}

const RESULT_KEY = 'result';

const NOT_JSON = Symbol('not-json');

function parseJsonIfPossible(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return NOT_JSON;
  }
}
