import type { RawSourceMap } from 'source-map';
import type { coresdk } from '@temporalio/proto';
import type { WorkflowCreateOptions } from '../interface';
import type { PatchActivationWorkflowInfoSnapshot } from '../patch-activation-callback';

export interface WorkflowBundleWithSourceMapAndFilename {
  code: string;
  sourceMap: RawSourceMap;
  filename: string;
}

/**
 * Initialize the workflow-worker-thread
 */
export interface Init {
  type: 'init';
  isolateExecutionTimeoutMs: number;
  workflowBundle: WorkflowBundleWithSourceMapAndFilename;
  registeredActivityNames: Set<string>;
  reuseV8Context: boolean;
  hasPatchActivationCallback: boolean;
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
  activation: coresdk.workflow_activation.IWorkflowActivation | Uint8Array;
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

/** A synchronous callback request sent from a Workflow thread to its owning Worker. */
export interface PatchActivationCallbackRequest {
  type: 'patch-activation-callback';
  workflowInfo: PatchActivationWorkflowInfoSnapshot;
  patchId: string;
  resultBuffer: SharedArrayBuffer;
}
