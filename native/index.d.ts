export declare interface WorkflowTask {
  taskToken: string;
  workflowID: string;
  type: string; // TODO: define the different types
}

export declare type PollResult = WorkflowTask; // TODO: | ActivityTask

export declare type PollCallback = (err?: Error, result?: PollResult) => void;
export declare function newWorker(queueName: string): Worker;
export declare function workerPoll(worker: Worker, callback: PollCallback): void;
export declare function workerSuspendPolling(worker: Worker): void;
export declare function workerResumePolling(worker: Worker): void;
export declare function workerIsSuspended(worker: Worker): boolean;

export interface Worker {
}
