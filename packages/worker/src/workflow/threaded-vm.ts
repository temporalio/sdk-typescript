/**
 * Wrapper for starting VM Workflows in Node Worker threads.
 * https://nodejs.org/api/worker_threads.html
 *
 * Worker threads are used here because creating vm contexts is a long running
 * operation which blocks the Node.js event loop causing the SDK Worker to
 * become unresponsive.
 *
 * @module
 */

import { coresdk } from '@temporalio/proto';
import { IllegalStateError, SinkCall } from '@temporalio/workflow';
import { Worker as NodeWorker } from 'worker_threads';
import { UnexpectedError } from '../errors';
import { Workflow, WorkflowCreateOptions, WorkflowCreator } from './interface';
import { WorkerThreadInput, WorkerThreadRequest } from './workflow-worker-thread/input';
import { WorkerThreadOutput, WorkerThreadResponse } from './workflow-worker-thread/output';

// https://nodejs.org/api/worker_threads.html#event-exit
export const TERMINATED_EXIT_CODE = 1;

interface Completion<T> {
  resolve(value: T): void;
  reject(error: any): void;
}

interface ErrorConstructor {
  new (message: string): Error;
}

/**
 * Helper to translate errors returned from worker thread to `Error` classes
 */
function errorNameToClass(name: string): ErrorConstructor {
  switch (name) {
    case 'IllegalStateError':
      return IllegalStateError;
    default:
      return Error;
  }
}

/**
 * Client for communicating with a workflow worker thread.
 *
 * Uses postMessage to send messages and listens on the `message` event to receive messages.
 */
export class WorkerThreadClient {
  requestIdx = 0n;
  requestIdToCompletion = new Map<BigInt, Completion<WorkerThreadOutput>>();
  shutDownRequested = false;
  workerExited = false;

  constructor(protected workerThread: NodeWorker) {
    workerThread.on('message', ({ requestId, result }: WorkerThreadResponse) => {
      const completion = this.requestIdToCompletion.get(requestId);
      if (completion === undefined) {
        throw new IllegalStateError(`Got completion for unknown requestId ${requestId}`);
      }
      this.requestIdToCompletion.delete(requestId);
      if (result.type === 'error') {
        const ctor = errorNameToClass(result.name);
        const err = new ctor(result.message);
        err.stack = result.stack;
        completion.reject(err);
        return;
      }

      completion.resolve(result.output);
    });
    workerThread.on('exit', () => {
      this.workerExited = true;
      if (this.shutDownRequested) {
        return; // ignore
      }
      const completions = this.requestIdToCompletion.values();
      this.requestIdToCompletion = new Map();
      for (const completion of completions) {
        completion.reject(
          new UnexpectedError(
            'Worker thread shut down prematurely, this could be caused by an' +
              ' unhandled rejection in workflow code that could not be' +
              ' associated with a workflow run'
          )
        );
      }
    });
  }

  /**
   * Send input to Worker thread and await for output
   */
  async send(input: WorkerThreadInput): Promise<WorkerThreadOutput> {
    const requestId = this.requestIdx++;
    const request: WorkerThreadRequest = { requestId, input };
    this.workerThread.postMessage(request);
    const promise = new Promise<WorkerThreadOutput>((resolve, reject) => {
      this.requestIdToCompletion.set(requestId, { resolve, reject });
    });
    return promise;
  }

  /**
   * Request destruction of the worker thread and await for it to terminate correctly
   */
  async destroy(): Promise<void> {
    if (this.workerExited) {
      return;
    }
    this.shutDownRequested = true;
    await this.send({ type: 'destroy' });
    const exitCode = await this.workerThread.terminate();
    if (exitCode !== TERMINATED_EXIT_CODE) {
      throw new UnexpectedError(`Failed to terminate Worker thread, exit code: ${exitCode}`);
    }
  }
}

export interface ThreadedVMWorkflowCreatorOptions {
  code: string;
  sourceMap: string;
  threadPoolSize: number;
  isolateExecutionTimeoutMs: number;
}

/**
 * A WorkflowCreator that creates vm Workflows inside Worker threads
 */
export class ThreadedVMWorkflowCreator implements WorkflowCreator {
  protected workflowThreadIdx = 0;

  /**
   * Create an instance of ThreadedVMWorkflowCreator asynchronously.
   *
   * This method creates and initializes the workflow-worker-thread instances.
   */
  static async create({
    threadPoolSize,
    code,
    sourceMap,
    isolateExecutionTimeoutMs,
  }: ThreadedVMWorkflowCreatorOptions): Promise<ThreadedVMWorkflowCreator> {
    const workerThreadClients = Array(threadPoolSize)
      .fill(0)
      .map(() => new WorkerThreadClient(new NodeWorker(require.resolve('./workflow-worker-thread'))));
    await Promise.all(
      workerThreadClients.map((client) => client.send({ type: 'init', code, sourceMap, isolateExecutionTimeoutMs }))
    );
    return new this(workerThreadClients);
  }

  constructor(protected readonly workerThreadClients: WorkerThreadClient[]) {}

  /**
   * Create a workflow with given options
   */
  async createWorkflow(options: WorkflowCreateOptions): Promise<Workflow> {
    const workflowThreadIdx = this.workflowThreadIdx;
    const workflow = await VMWorkflowThreadProxy.create(this.workerThreadClients[workflowThreadIdx], options);
    this.workflowThreadIdx = (this.workflowThreadIdx + 1) % this.workerThreadClients.length;
    return workflow;
  }

  /**
   * Destroy and terminate all threads created by this instance
   */
  async destroy(): Promise<void> {
    await Promise.all(this.workerThreadClients.map((client) => client.destroy()));
  }
}

/**
 * A proxy class used to communicate with a VMWorkflow instance in a worker thread.
 */
export class VMWorkflowThreadProxy implements Workflow {
  /**
   * Send a create-workflow command to the thread and await for acknowledgement
   */
  static async create(
    workerThreadClient: WorkerThreadClient,
    options: WorkflowCreateOptions
  ): Promise<VMWorkflowThreadProxy> {
    await workerThreadClient.send({ type: 'create-workflow', options });
    return new this(workerThreadClient, options.info.runId);
  }

  constructor(protected readonly workerThreadClient: WorkerThreadClient, public readonly runId: string) {}

  /**
   * Proxy request to the VMWorkflow instance
   */
  async getAndResetSinkCalls(): Promise<SinkCall[]> {
    const output = await this.workerThreadClient.send({
      type: 'extract-sink-calls',
      runId: this.runId,
    });
    if (output?.type !== 'sink-calls') {
      throw new TypeError(`Got invalid response output from Workflow Worker thread ${output}`);
    }
    return output.calls;
  }

  /**
   * Proxy request to the VMWorkflow instance
   */
  async activate(activation: coresdk.workflow_activation.IWorkflowActivation): Promise<Uint8Array> {
    const arr = coresdk.workflow_activation.WorkflowActivation.encodeDelimited(activation).finish();
    const output = await this.workerThreadClient.send({
      type: 'activate-workflow',
      activation: arr,
      runId: this.runId,
    });
    if (output?.type !== 'activation-completion') {
      throw new TypeError(`Got invalid response output from Workflow Worker thread ${output}`);
    }
    return output.completion;
  }

  /**
   * Proxy request to the VMWorkflow instance
   */
  async dispose(): Promise<void> {
    await this.workerThreadClient.send({ type: 'dispose-workflow', runId: this.runId });
  }
}
