import { Headers } from 'headers-polyfill';
import { inWorkflowContext } from '@temporalio/workflow';

if (inWorkflowContext()) {
  // Apply Headers polyfill
  if (typeof globalThis.Headers === 'undefined') {
    globalThis.Headers = Headers;
  }

  // Attach the polyfill as a Global function
  if (!('structuredClone' in globalThis)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const structuredClone = require('@ungap/structured-clone');
    globalThis.structuredClone = structuredClone.default;
  }
}
