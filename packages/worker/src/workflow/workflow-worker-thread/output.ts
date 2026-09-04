import { type coresdk } from '@temporalio/proto';
import { type SinkCall } from '@temporalio/workflow/lib/sinks';

/**
 * An activation completion.
 *
 * Used as response to an `ActivateWorkflow` request.
 */
export interface ActivationCompletion {
  type: 'activation-completion';
  completion: coresdk.workflow_completion.IWorkflowActivationCompletion | Uint8Array;
}

/**
 * Response to a `ExtractSinkCalls` request.
 */
export interface SinkCallList {
  type: 'sink-calls';
  calls: SinkCall[];
}

/** The requested Workflow was already discarded locally while awaiting Core's eviction marker. */
export interface WorkflowLocallyEvicted {
  type: 'workflow-locally-evicted';
}

export type WorkerThreadOutput = ActivationCompletion | SinkCallList | WorkflowLocallyEvicted | undefined;

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

/** Unsolicited notification that the thread discarded idle Workflows due to heap pressure. */
export interface WorkflowEvictionNotification {
  type: 'workflow-evictions';
  runIds: string[];
  usedHeapSize: number;
  heapSizeLimit: number;
}
