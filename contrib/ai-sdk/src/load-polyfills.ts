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
 * Internal: called only by `preload-polyfills`, which AiSdkPlugin.configureBundler prepends to
 * the workflow bundle's webpack entry so it runs before any other workflow module.
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
