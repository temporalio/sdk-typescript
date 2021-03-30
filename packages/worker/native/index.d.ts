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
export declare type WorkerCallback = (err?: Error, result: Worker) => void;
export declare type VoidCallback = (err?: Error, result: void) => void;

export declare function newWorker(serverOptions: ServerOptions, callback: WorkerCallback): void;
export declare function workerShutdown(worker: Worker): void;
export declare function workerPollWorkflowActivation(worker: Worker, queueName: string, callback: PollCallback): void;
export declare function workerCompleteWorkflowActivation(
  worker: Worker,
  result: ArrayBuffer,
  callback: VoidCallback
): void;
export declare function workerPollActivityTask(worker: Worker, queueName: string, callback: PollCallback): void;
export declare function workerCompleteActivityTask(worker: Worker, result: ArrayBuffer, callback: VoidCallback): void;
export declare function workerSendActivityHeartbeat(
  worker: Worker,
  activityId: string,
  details?: ArrayBuffer,
  callback: VoidCallback
): void;
