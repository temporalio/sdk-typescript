/**
 * Real workflow imports for otel interceptors.
 * This replaces the stub via webpack alias when bundled.
 *
 * @module
 */
export { inWorkflowContext, proxySinks, workflowInfo, AsyncLocalStorage, ContinueAsNew } from '@temporalio/workflow';
export { SdkFlags } from '@temporalio/workflow/internal/flags';
export { getActivator } from '@temporalio/workflow/internal/global-attributes';
