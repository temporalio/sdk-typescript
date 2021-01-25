export declare interface PollResult {
  // type: 'WorkflowExecutionStarted' | 'TimerStarted';
  taskToken: string;
  type: string;
}

export declare type PollCallback = (err?: Error, result?: PollResult) => void;
export declare function newWorker(queueName: string): Worker;
export declare function workerPoll(worker: Worker, callback: PollCallback): void;

export interface Worker {
}
