import { SinkCall } from '@temporalio/workflow/lib/sinks';

/**
 * A serialized coresdk.workflow_completion.WorkflowActivationCompletion proto.
 *
 * Used as response to an `ActivateWorkflow` request.
 */
export interface ActivationCompletion {
  type: 'activation-completion';
  completion: Uint8Array;
}

/**
 * Response to a `ExtractSinkCalls` request.
 */
export interface SinkCallList {
  type: 'sink-calls';
  calls: SinkCall[];
}

export type WorkerThreadOutput = ActivationCompletion | SinkCallList | undefined;

/**
 * Successful result for a given request
 */
export interface WorkerThreadOkResult {
  type: 'ok';
  output?: WorkerThreadOutput;
}

/**
 * Error result for a given request
 */
export interface WorkflowThreadErrorResult {
  type: 'error';
  /** Error class name */
  name: string;
  message: string;
  stack: string;
}

/**
 * Response to a WorkerThreadRequest.
 */
export interface WorkerThreadResponse {
  /**
   * ID provided in the originating `WorkerThreadRequest`
   */
  requestId: bigint;

  result: WorkerThreadOkResult | WorkflowThreadErrorResult;
}
