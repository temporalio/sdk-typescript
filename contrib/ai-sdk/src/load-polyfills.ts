import { Headers } from 'headers-polyfill';
import structuredClonePolyfill from '@ungap/structured-clone';
import * as webStreamsPolyfill from 'web-streams-polyfill';

/**
 * Installs the Web-API globals that the AI SDK needs inside the workflow sandbox: `Headers`,
 * the Web Streams classes (`ReadableStream`, `WritableStream`, `TransformStream`, ...), and
 * `structuredClone`.
 *
 * Idempotent, and never overwrites globals that already exist — calling it outside the sandbox
 * (where Node.js provides all of these natively) is a no-op.
 *
 * Called by the `@temporalio/ai-sdk/workflow` entry point when it is loaded; workflow code that
 * imports from that entry point does not need to call this directly.
 *
 * @experimental The AI SDK integration is an experimental feature; APIs may change without notice.
 */
export function installPolyfills(): void {
  if (typeof globalThis.Headers === 'undefined') {
    globalThis.Headers = Headers;
  }

  for (const [name, impl] of Object.entries(webStreamsPolyfill)) {
    if (name !== 'default' && !(name in globalThis)) {
      (globalThis as Record<string, unknown>)[name] = impl;
    }
  }

  if (!('structuredClone' in globalThis)) {
    globalThis.structuredClone = structuredClonePolyfill as typeof globalThis.structuredClone;
  }
}
