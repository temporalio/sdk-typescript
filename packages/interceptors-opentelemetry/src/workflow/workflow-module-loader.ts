/**
 * Utilities for working with a possibly missing `@temporalio/workflow` peer dependency
 * @module
 */
import type * as WorkflowModule from '@temporalio/workflow';

// @temporalio/workflow is an optional peer dependency.
// It can be missing as long as the user isn't attempting to construct a workflow interceptor.
// If we start shipping ES modules alongside CJS, we will have to reconsider
// this dynamic import as `import` is async for ES modules.
let workflowModule: typeof WorkflowModule | undefined;
let workflowModuleLoadError: any | undefined;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  workflowModule = require('@temporalio/workflow');
} catch (err) {
  // Capture the module not found error to rethrow if the module is required
  workflowModuleLoadError = err;
}

/**
 * Returns `@temporalio/workflow` module if present.
 * Throws if the module failed to load
 */
export function getWorkflowModule(): typeof WorkflowModule {
  if (workflowModuleLoadError) {
    throw workflowModuleLoadError;
  }
  return workflowModule!;
}

/**
 * Checks if the workflow module loaded successfully and throws if not.
 */
export function ensureWorkflowModuleLoaded(): void {
  if (workflowModuleLoadError) {
    throw workflowModuleLoadError;
  }
}

/**
 * Returns the workflow module if available, or undefined if it failed to load.
 */
export function getWorkflowModuleIfAvailable(): typeof WorkflowModule | undefined {
  return workflowModule;
}
