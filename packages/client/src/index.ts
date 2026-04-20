/**
 * Client for communicating with Temporal Server.
 *
 * Most functionality is available through {@link WorkflowClient}, but you can also call gRPC methods directly using {@link Connection.workflowService} and {@link Connection.operatorService}.
 *
 * ### Usage
 *
 * ```ts
 * import { Connection, Client } from '@temporalio/client';
 * import { loadClientConnectConfig } from '@temporalio/envconfig';
 * import { sleepForDays } from './workflows';
 * import { nanoid } from 'nanoid';
 *
 * async function run() {
 *   const config = loadClientConnectConfig();
 *   const connection = await Connection.connect(config.connectionOptions);
 *   const client = new Client({ connection });
 *
 *   const handle = await client.workflow.start(sleepForDays, {
 *     taskQueue: 'sleep-for-days',
 *     workflowId: 'workflow-' + nanoid(),
 *   });
 *   console.log(`Started workflow ${handle.workflowId}`);
 *
 *   // Wait for workflow completion (runs indefinitely until it receives a signal)
 *   console.log(await handle.result());
 * }
 *
 * run().catch((err) => {
 *   console.error(err);
 *   process.exit(1);
 * });
 * ```
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
  RetryPolicy,
  ServerFailure,
  TemporalFailure,
  TerminatedFailure,
  TimeoutFailure,
  WorkflowExecutionAlreadyStartedError,
} from '@temporalio/common';
export { TLSConfig } from '@temporalio/common/lib/internal-non-workflow';
export * from '@temporalio/common/lib/errors';
export * from '@temporalio/common/lib/interfaces';
export * from '@temporalio/common/lib/workflow-handle';
export * from './async-completion-client';
export * from './client';
export {
  Connection,
  ConnectionOptions,
  ConnectionOptionsWithDefaults,
  ConnectionPlugin,
  LOCAL_TARGET,
} from './connection';
export * from './errors';
export * from './grpc-retry';
export * from './interceptors';
export * from './types';
export * from './workflow-client';
export * from './workflow-options';
export * from './schedule-types';
export * from './schedule-client';
export * from './task-queue-client';
export { WorkflowUpdateStage } from './workflow-update-stage';
export {
  WorkerBuildIdVersionSets,
  BuildIdVersionSet,
  BuildIdOperation,
  PromoteSetByBuildId,
  PromoteBuildIdWithinSet,
  MergeSets,
  AddNewIdInNewDefaultSet,
  AddNewCompatibleVersion,
} from './build-id-types';
