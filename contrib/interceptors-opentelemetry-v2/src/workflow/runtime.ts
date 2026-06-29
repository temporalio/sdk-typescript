/**
 * Sets global variables required for importing opentelemetry in isolate
 * @module
 */
import { inWorkflowContext } from './workflow-imports';

if (inWorkflowContext()) {
  // OTel uses `window` to detect a browser environment
  Object.assign(globalThis, {
    window: globalThis,
  });
}
