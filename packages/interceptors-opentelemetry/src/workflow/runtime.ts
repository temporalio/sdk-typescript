/**
 * Sets global variables required for importing opentelemetry in isolate
 * @module
 */

// Check if we're in workflow context by looking for the activator.
// This is set by initRuntime() before interceptors are loaded.
const inWorkflowContext = (globalThis as any).__TEMPORAL_ACTIVATOR__ !== undefined;

// Export to make this a valid ES module (required by eslint import/unambiguous)
export {};

if (inWorkflowContext) {
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
