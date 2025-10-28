/**
 * Sets global variables required for importing opentelemetry in isolate
 * @module
 */
import { getWorkflowModuleIfAvailable } from './workflow-module-loader';

const inWorkflowContext = getWorkflowModuleIfAvailable()?.inWorkflowContext;

if (inWorkflowContext?.()) {
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
