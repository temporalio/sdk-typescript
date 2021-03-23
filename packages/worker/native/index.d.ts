export interface ServerOptions {
  /**
   * The URL of the Temporal server to connect to
   */
  url: string;
  /**
   * What namespace will we operate under
   */
  namespace: string;

  /**
   * A human-readable string that can identify your worker
   */
  identity: string;
  /**
   * A string that should be unique to the exact worker code/binary being executed
   */
  workerBinaryId: string;
  /**
   * Timeout for long polls (polling of task queues)
   */
  longPollTimeoutMs: number;
}

export interface Worker {}

export declare type PollCallback = (err?: Error, result: ArrayBuffer) => void;
export declare function newWorker(serverOptions: ServerOptions): Worker;
export declare function workerShutdown(worker: Worker): void;
export declare function workerPoll(worker: Worker, queueName: string, callback: PollCallback): void;
export declare function workerCompleteTask(worker: Worker, result: ArrayBuffer): void;
export declare function workerSendActivityHeartbeat(worker: Worker, activityId: string, details?: ArrayBuffer): void;
