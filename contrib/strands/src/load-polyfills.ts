import { Headers } from 'headers-polyfill';
import { inWorkflowContext } from '@temporalio/workflow';

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
}
