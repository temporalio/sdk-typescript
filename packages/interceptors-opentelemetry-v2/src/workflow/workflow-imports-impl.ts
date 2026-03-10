/**
 * Real workflow imports for otel interceptors.
 * This replaces the stub via webpack alias when bundled.
 *
 * @module
 */
export { inWorkflowContext, proxySinks, workflowInfo, AsyncLocalStorage, ContinueAsNew } from '@temporalio/workflow';
export { alea, type RNG } from '@temporalio/workflow/lib/alea';
