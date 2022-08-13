import { WorkflowCreateOptions } from '../interface';

/**
 * Initialize the workflow-worker-thread
 */
export interface Init {
  type: 'init';
  isolateExecutionTimeoutMs: number;
  code: string;
  sourceMap: string;
}

/**
 * Destroy the workflow-worker-thread
 */
export interface Destroy {
  type: 'destroy';
}

/**
 * Create a new Workflow with given options
 */
export interface CreateWorkflow {
  type: 'create-workflow';
  options: WorkflowCreateOptions;
}

/**
 * Activate a Workflow by runId
 */
export interface ActivateWorkflow {
  type: 'activate-workflow';
  runId: string;
  /**
   * Serialized coresdk.workflow_activation.WorkflowActivation proto
   */
  activation: Uint8Array;
}

/**
 * Extract buffered sink calls from Workflow by runId
 */
export interface ExtractSinkCalls {
  type: 'extract-sink-calls';
  runId: string;
}

/**
 * Dispose workflow by runId
 */
export interface DisposeWorkflow {
  type: 'dispose-workflow';
  runId: string;
}

export type WorkerThreadInput = Init | Destroy | CreateWorkflow | ActivateWorkflow | ExtractSinkCalls | DisposeWorkflow;

/**
 * Request including a unique ID and input.
 * The ID is used to respond to this request
 */
export interface WorkerThreadRequest {
  requestId: bigint;
  input: WorkerThreadInput;
}
