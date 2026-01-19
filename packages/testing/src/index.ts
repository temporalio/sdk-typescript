/**
 * `npm i @temporalio/testing`
 *
 * Testing library for the SDK.
 *
 * [Documentation](https://docs.temporal.io/typescript/testing)
 *
 * @module
 */

import path from 'node:path';

export {
  TestWorkflowEnvironment,
  type LocalTestWorkflowEnvironmentOptions,
  type TimeSkippingTestWorkflowEnvironmentOptions,
  type ExistingServerTestWorkflowEnvironmentOptions,
  type NexusEndpointIdentifier,
} from './testing-workflow-environment';

export {
  type DevServerConfig,
  type TimeSkippingServerConfig,
  type EphemeralServerExecutable,
} from './ephemeral-server';

export { type ClientOptionsForTestEnv, TimeSkippingWorkflowClient } from './client';

export {
  type MockActivityEnvironmentOptions,
  MockActivityEnvironment,
  defaultActivityInfo,
} from './mocking-activity-environment';

/**
 * Convenience workflow interceptors
 *
 * Contains a single interceptor for transforming `AssertionError`s into non
 * retryable `ApplicationFailure`s.
 */
export const workflowInterceptorModules = [path.join(__dirname, 'assert-to-failure-interceptor')];
