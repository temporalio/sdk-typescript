/**
 * Sets global variables required for importing opentelemetry in isolate
 * @module
 */
import { inWorkflowContext } from './workflow-imports';

if (inWorkflowContext()) {
  // Required by opentelemetry (pretend to be a browser)
  Object.assign(globalThis, {
    performance: {
      timeOrigin: Date.now(),
      now() {
        return Date.now() - this.timeOrigin;
      },
    },
    window: globalThis,
  });
}
