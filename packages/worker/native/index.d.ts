export interface Worker {}

export declare type PollCallback = (err?: Error, result?: ArrayBuffer) => void;
export declare function newWorker(): Worker;
export declare function workerShutdown(worker: Worker): void;
export declare function workerPoll(worker: Worker, queueName: string, callback: PollCallback): void;
export declare function workerCompleteTask(worker: Worker, result: ArrayBuffer): void;
export declare function workerSendActivityHeartbeat(worker: Worker, activityId: string, details?: ArrayBuffer): void;
