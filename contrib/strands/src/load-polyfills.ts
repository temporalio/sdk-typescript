import { Headers } from 'headers-polyfill';
import { inWorkflowContext, uuid4 } from '@temporalio/workflow';

if (inWorkflowContext()) {
  if (typeof globalThis.Headers === 'undefined') {
    globalThis.Headers = Headers;
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports,import/no-unassigned-import
  require('web-streams-polyfill/polyfill');

  if (!('structuredClone' in globalThis)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const structuredClone = require('@ungap/structured-clone');
    globalThis.structuredClone = structuredClone.default;
  }

  // `@ungap/structured-clone` calls `crypto.randomUUID()` internally, but the
  // workflow sandbox bans the real `crypto` module. Use the SDK's
  // deterministic `uuid4` so the polyfill still works at replay.
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    globalThis.crypto = { ...(globalThis.crypto ?? {}), randomUUID: uuid4 } as never;
  }
}
