/**
 * Sets global variables required for importing opentelemetry in isolate.
 *
 * Note: `performance` is polyfilled separately in `performance-polyfill.ts`
 * (a zero-import file) to ensure it's available before OTel v2 modules that
 * eagerly access `performance` at module scope.
 *
 * @module
 */
import { inWorkflowContext } from './workflow-imports';

if (inWorkflowContext()) {
  // OTel uses `window` to detect a browser environment
  Object.assign(globalThis, {
    window: globalThis,
  });
}
