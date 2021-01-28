export declare interface WorkflowTask {
  taskToken: string;
  timestamp: number;
  workflowID: string;
  type: string; // TODO: define the different types
}

import { Command } from '../workflow-lib/lib/internals';

export declare interface BaseTaskResult {
  taskToken: string;
}

export declare interface BaseWorkflowTaskResult extends BaseTaskResult {
  completionType: 'workflow';
}

export declare interface SuccessWorkflowTaskResult extends BaseWorkflowTaskResult {
  ok: {
    commands: Command[];
  }
}

export declare interface FailureWorkflowTaskResult extends BaseWorkflowTaskResult {
  error: string;
}

export declare type WorkflowTaskResult = SuccessWorkflowTaskResult | FailureWorkflowTaskResult;

export declare type TaskResult = WorkflowTaskResult; // TODO: | ActivityTaskResult

export declare type PollResult = WorkflowTask; // TODO: | ActivityTask

export declare type PollCallback = (err?: Error, result?: PollResult) => void;
export declare function newWorker(queueName: string): Worker;
export declare function workerPoll(worker: Worker, callback: PollCallback): void;
export declare function workerCompleteTask(worker: Worker, result: TaskResult): boolean;
export declare function workerSuspendPolling(worker: Worker): void;
export declare function workerResumePolling(worker: Worker): void;
export declare function workerIsSuspended(worker: Worker): boolean;

export interface Worker {
}
