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
export { RetryPolicy } from '@temporalio/internal-workflow-common';
export * from './async-completion-client';
export * from './connection';
export * from './errors';
export * from './interceptors';
export * from './types';
export * from './workflow-client';
export * from './workflow-options';
