/**
 * Real workflow imports for otel interceptors.
 * This replaces the stub via webpack alias when bundled.
 *
 * @module
 */
export {
  inWorkflowContext,
  proxySinks,
  workflowInfo,
  AsyncLocalStorage,
  ContinueAsNew,
  getRandomStream,
} from '@temporalio/workflow';
