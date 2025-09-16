import { inWorkflowContext } from '@temporalio/workflow';

if (inWorkflowContext()) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports,import/no-unassigned-import
  require('web-streams-polyfill/polyfill');
  // Attach the polyfill as a Global function
  if (!("structuredClone" in globalThis)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports,import/no-unassigned-import
    const structuredClone = require('@ungap/structured-clone');
    globalThis.structuredClone = structuredClone.default;
  }
}