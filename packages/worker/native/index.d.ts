// NOTE: this interface is duplicated in the client module `packages/client/src/index.ts` for lack of a shared library

/** TLS configuration options. */
export interface TLSConfig {
  /**
   * Overrides the target name used for SSL host name checking.
   * If this attribute is not specified, the name used for SSL host name checking will be the host from {@link ServerOptions.url}.
   * This _should_ be used for testing only.
   */
  serverNameOverride?: string;
  /**
   * Root CA certificate used by the server. If not set, and the server's
   * cert is issued by someone the operating system trusts, verification will still work (ex: Cloud offering).
   */
  serverRootCACertificate?: Buffer;
  /** Sets the client certificate and key for connecting with mTLS */
  clientCertPair?: {
    /** The certificate for this client */
    crt: Buffer;
    /** The private key for this client */
    key: Buffer;
  };
}

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

  /**
   * TLS configuration options.
   *
   * Pass undefined to use a non-encrypted connection or an empty object to
   * connect with TLS without any customization.
   */
  tls?: TLSConfig;
}

export interface WorkerOptions {
  /**
   * Options for communicating with the Temporal server
   */
  serverOptions: ServerOptions;

  /**
   * The task queue the worker will pull from
   */
  taskQueue: string;

  maxConcurrentActivityTaskExecutions: number;
  maxConcurrentWorkflowTaskExecutions: number;
  maxConcurrentWorkflowTaskPolls: number;
  maxConcurrentActivityTaskPolls: number;
}

export interface Worker {}

export declare type PollCallback = (err: Error, result: ArrayBuffer) => void;
export declare type WorkerCallback = (err: Error, result: Worker) => void;
export declare type VoidCallback = (err: Error, result: void) => void;

// TODO: improve type, for some reason Error is not accepted here
export declare function registerErrors(errors: Record<string, any>): void;
export declare function newWorker(workerOptions: WorkerOptions, callback: WorkerCallback): void;
export declare function workerShutdown(worker: Worker, callback: VoidCallback): void;
export declare function workerBreakLoop(worker: Worker, callback: VoidCallback): void;
export declare function workerPollWorkflowActivation(worker: Worker, callback: PollCallback): void;
export declare function workerCompleteWorkflowActivation(
  worker: Worker,
  result: ArrayBuffer,
  callback: VoidCallback
): void;
export declare function workerPollActivityTask(worker: Worker, callback: PollCallback): void;
export declare function workerCompleteActivityTask(worker: Worker, result: ArrayBuffer, callback: VoidCallback): void;
export declare function workerRecordActivityHeartbeat(worker: Worker, heartbeat: ArrayBuffer): void;
