/**
 * Sets global variables required for importing opentelemetry in isolate
 * @module
 */
import type { inWorkflowContext as InWorkflowContext } from '@temporalio/workflow';

// @temporalio/workflow is an optional peer dependency and might not be available.
// If it is not available, we can assume that we are not in a workflow context.
let inWorkflowContext: typeof InWorkflowContext | undefined;
try {
  inWorkflowContext = require('@temporalio/workflow').inWorkflowContext;
} catch (_) {
  inWorkflowContext = undefined;
}

if (inWorkflowContext && inWorkflowContext()) {
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
