import type { RawSourceMap } from 'source-map';
import { coresdk } from '@temporalio/proto';
import { WorkflowCreateOptions } from '../interface';

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
  activation: coresdk.workflow_activation.IWorkflowActivation;
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
