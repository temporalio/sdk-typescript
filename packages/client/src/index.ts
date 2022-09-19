/**
 * Client for communicating with Temporal Server.
 *
 * Most functionality is available through {@link WorkflowClient}, but you can also call gRPC methods directly using {@link Connection.workflowService} and {@link Connection.operatorService}.
 *
 * ### Usage
 * <!--SNIPSTART typescript-hello-client-->
 * <!--SNIPEND-->
 * @module
 */

export {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  ChildWorkflowFailure,
  DataConverter,
  defaultPayloadConverter,
  ProtoFailure,
  ServerFailure,
  TemporalFailure,
  TerminatedFailure,
  TimeoutFailure,
} from '@temporalio/common';
export { TLSConfig } from '@temporalio/internal-non-workflow-common';
export { RetryPolicy } from '@temporalio/internal-workflow-common';
export * from '@temporalio/internal-workflow-common/lib/errors';
export * from '@temporalio/internal-workflow-common/lib/interfaces';
export * from '@temporalio/internal-workflow-common/lib/workflow-handle';
export * from './async-completion-client';
export * from './client';
export { Connection, ConnectionOptions, ConnectionOptionsWithDefaults, LOCAL_TARGET } from './connection';
export * from './errors';
export * from './grpc-retry';
export * from './interceptors';
export * from './types';
export * from './workflow-client';
export * from './workflow-options';
