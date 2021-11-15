import { WorkflowCreateOptions } from '../interface';

export interface Init {
  type: 'init';
  isolateExecutionTimeoutMs: number;
  code: string;
}

export interface Destroy {
  type: 'destroy';
}

export interface CreateWorkflow {
  type: 'create-workflow';
  options: WorkflowCreateOptions;
}

export interface ActivateWorkflow {
  type: 'activate-workflow';
  runId: string;
  activation: Uint8Array;
}

export interface ExtractSinkCalls {
  type: 'exteract-sink-calls';
  runId: string;
}

export interface DisposeWorkflow {
  type: 'dispose-workflow';
  runId: string;
}

export type WorkerThreadInput = Init | Destroy | CreateWorkflow | ActivateWorkflow | ExtractSinkCalls | DisposeWorkflow;

export interface WorkerThreadRequest {
  requestId: BigInt;
  input: WorkerThreadInput;
}
