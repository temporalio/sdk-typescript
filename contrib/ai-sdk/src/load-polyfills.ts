import { Headers } from 'headers-polyfill';
import structuredClonePolyfill from '@ungap/structured-clone';
import * as webStreamsPolyfill from 'web-streams-polyfill';
import { decodeBase64, encodeBase64 } from '@temporalio/workflow-streams/workflow';

function atobPolyfill(input: string): string {
  const encoded = String(input).replace(/[\t\n\f\r ]/g, '');
  const paddingLength = encoded.match(/=+$/)?.[0].length ?? 0;
  if (paddingLength > 0 && encoded.length % 4 !== 0) {
    throw new TypeError('The string to be decoded is not correctly encoded.');
  }

  const bytes = decodeBase64(encoded);
  let output = '';
  for (const byte of bytes) {
    output += String.fromCharCode(byte);
  }
  return output;
}

function btoaPolyfill(input: string): string {
  const data = String(input);
  const bytes = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index++) {
    const byte = data.charCodeAt(index);
    if (byte > 0xff) {
      throw new TypeError('The string to be encoded contains characters outside of the Latin1 range.');
    }
    bytes[index] = byte;
  }
  return encodeBase64(bytes);
}

/**
 * Installs the Web-API globals that the AI SDK needs inside the workflow sandbox: `Headers`,
 * the Web Streams classes (`ReadableStream`, `WritableStream`, `TransformStream`, ...),
 * `structuredClone`, and the base64 helpers `atob` and `btoa`.
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

  if (typeof globalThis.atob === 'undefined') {
    globalThis.atob = atobPolyfill;
  }

  if (typeof globalThis.btoa === 'undefined') {
    globalThis.btoa = btoaPolyfill;
  }
}
