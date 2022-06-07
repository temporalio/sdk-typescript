/**
 * Client for communicating with the Temporal service.
 *
 * Interact with workflows using {@link WorkflowClient} or call GRPC methods directly using {@link Connection.service}.
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
export * from '@temporalio/internal-workflow-common/lib/interfaces';
export * from './async-completion-client';
export { Connection, ConnectionOptions, ConnectionOptionsWithDefaults, LOCAL_TARGET } from './connection';
export * from './errors';
export * from './grpc-retry';
export * from './interceptors';
export * from './types';
export * from './workflow-client';
export * from './workflow-options';
