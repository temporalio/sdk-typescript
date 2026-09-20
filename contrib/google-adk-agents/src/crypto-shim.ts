/**
 * Deterministic `crypto` module for `@google/adk` inside the Workflow sandbox.
 *
 * ADK's id generator (`utils/env_aware_utils.ts`, `randomUUID()`) tries
 * `globalThis.crypto.randomUUID`, then `globalThis.crypto.getRandomValues`, and
 * finally the `randomUUID` it statically imports from `node:crypto`. The sandbox
 * exposes no `crypto` global and the Worker bundler aliases the `crypto` builtin
 * to an empty module, so from ADK 1.6 onward — which dropped the `Math.random()`
 * fallback ADK 1.5 had — the first `createEvent()` / `createSession()` in a
 * Workflow would throw `nodeRandomUUID is not a function`. The plugin's bundler
 * plugin redirects `crypto` / `node:crypto` requests issued from inside
 * `@google/adk` to this module instead.
 *
 * Every value comes from a **named** workflow random stream
 * (`getRandomStream`), which is seeded per run and replays identically without
 * consuming from the workflow's own `Math.random()` sequence. That is what
 * makes ADK's event, invocation, session and function-call ids, and
 * `RequestInput` interrupt ids, stable across replay — a human-in-the-loop
 * response is matched by id, so the id must regenerate byte-for-byte.
 *
 * These values are NOT cryptographically random. Inside a Workflow that is the
 * point (determinism); it also means ADK's OAuth2 `state` parameter and session
 * identifiers are predictable there, which is one reason credential flows are
 * unsupported in Workflows (see the README).
 *
 * `getRandomStream` asserts workflow context, so it is called lazily — this
 * module is evaluated at bundle load, before any activator exists.
 *
 * IMPORTANT: this module is part of the Workflow-sandbox import graph. It must
 * not import any worker-only module.
 */

import { getRandomStream, type WorkflowRandomStream } from '@temporalio/workflow';

/**
 * The stream name is the package name: private to this plugin, so a user's
 * own `getRandomStream('…')` and the workflow's default `Math.random()` are
 * unaffected by how many ids ADK draws.
 */
const STREAM_NAME = '@temporalio/google-adk-agents';

function stream(): WorkflowRandomStream {
  return getRandomStream(STREAM_NAME);
}

/** An RFC 4122 version-4 UUID drawn from the plugin's workflow random stream. */
export function randomUUID(): string {
  return stream().uuid4();
}

/**
 * Fills `view` in place with bytes from the plugin's workflow random stream and
 * returns it — the WebCrypto `getRandomValues` contract, for any integer typed
 * array (the fill is byte-wise over the view's underlying storage).
 */
export function getRandomValues<T extends ArrayBufferView>(view: T): T {
  stream().fill(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return view;
}

/** Mirrors `node:crypto`'s `webcrypto` namespace for consumers that reach it. */
export const webcrypto = { randomUUID, getRandomValues };

export default { randomUUID, getRandomValues, webcrypto };
