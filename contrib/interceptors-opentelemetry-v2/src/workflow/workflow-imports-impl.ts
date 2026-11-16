/**
 * Real workflow imports for otel interceptors.
 * This replaces the stub via webpack alias when bundled.
 *
 * @module
 */
/** @lintignore These exports replace the stub's exports at bundle time; Knip cannot follow the webpack alias. */
export {
  inWorkflowContext,
  proxySinks,
  workflowInfo,
  AsyncLocalStorage,
  ContinueAsNew,
  getRandomStream,
} from '@temporalio/workflow';
