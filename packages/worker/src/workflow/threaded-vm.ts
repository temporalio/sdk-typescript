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

import { Worker as NodeWorker } from 'node:worker_threads';
import { setTimeout } from 'node:timers/promises';
import { coresdk } from '@temporalio/proto';
import { IllegalStateError, type SinkCall } from '@temporalio/workflow';
import { createUnsafeRandomSource } from '@temporalio/workflow/lib/random-helpers';
import type { Logger } from '@temporalio/common';
import type { PatchActivationCallback } from '../worker-options';
import { UnexpectedError } from '../errors';
import { MiB } from '../utils';
import type {
  Init,
  PatchActivationCallbackRequest,
  WorkflowBundleWithSourceMapAndFilename,
  WorkerThreadInput,
  WorkerThreadRequest,
} from './workflow-worker-thread/input';
import type { Workflow, WorkflowCreateOptions, WorkflowCreator, WorkflowThreadEvictionEvent } from './interface';
import type {
  WorkerThreadOutput,
  WorkerThreadResponse,
  WorkflowEvictionNotification,
} from './workflow-worker-thread/output';
import { isBunPre1_4 } from './bun';
import {
  WorkflowLocallyEvictedError,
  WorkflowThreadDisposalError,
  WorkflowThreadLostError,
} from './threaded-vm-errors';
import {
  completePatchActivationCallback,
  invokePatchActivationCallbackWithSnapshot,
  writePatchActivationCallbackError,
  writePatchActivationCallbackResult,
} from './patch-activation-callback';

// https://nodejs.org/api/worker_threads.html#event-exit
// Bun pre 1.4 exits with code 0 instead of 1
export const TERMINATED_EXIT_CODE = isBunPre1_4 ? 0 : 1;

interface Completion<T> {
  input: WorkerThreadInput;
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
  private requestIdx = 0n;
  private requestIdToCompletion = new Map<bigint, Completion<WorkerThreadOutput>>();
  private shutDownRequested = false;
  private workerExited = false;
  private exitError: WorkflowThreadLostError | undefined;
  private readonly workflowRunIds = new Set<string>();

  constructor(
    protected workerThread: NodeWorker,
    protected logger: Logger,
    protected patchActivationCallback?: PatchActivationCallback,
    protected onEviction?: (notification: WorkflowEvictionNotification) => void,
    protected onUnexpectedExit?: (client: WorkerThreadClient, runIds: string[], error: WorkflowThreadLostError) => void
  ) {
    workerThread.on(
      'message',
      (message: WorkerThreadResponse | PatchActivationCallbackRequest | WorkflowEvictionNotification) => {
        if (!('requestId' in message)) {
          if (message.type === 'patch-activation-callback') {
            this.handlePatchActivationCallback(message);
          } else {
            for (const runId of message.runIds) this.workflowRunIds.delete(runId);
            this.onEviction?.(message);
          }
          return;
        }
        const { requestId, result } = message;
        const completion = this.requestIdToCompletion.get(requestId);
        if (completion === undefined) {
          throw new IllegalStateError(`Got completion for unknown requestId ${requestId}`);
        }
        if (result.type === 'error') {
          if (result.name === 'WorkflowThreadDisposalError') {
            const disposalError = new WorkflowThreadDisposalError(result.message);
            disposalError.stack = result.stack;
            this.exitError = new WorkflowThreadLostError(
              'Workflow Worker Thread failed to dispose a Workflow and will be replaced',
              disposalError
            );
            this.logger.warn(this.exitError.message, { error: disposalError });
            // Keep the completion pending. The exit handler rejects every outstanding request only after the
            // creator has synchronously requested Core eviction for all Workflows owned by this thread.
            void this.workerThread.terminate().catch((error) => {
              this.logger.error('Failed to terminate Workflow Worker Thread after a disposal failure', { error });
            });
            return;
          }
          this.requestIdToCompletion.delete(requestId);
          if (completion.input.type === 'create-workflow' || completion.input.type === 'dispose-workflow') {
            const runId =
              completion.input.type === 'create-workflow'
                ? completion.input.options.info.runId
                : completion.input.runId;
            this.workflowRunIds.delete(runId);
          }
          const ctor = errorNameToClass(result.name);
          const err = new ctor(result.message);
          err.stack = result.stack;
          completion.reject(err);
          return;
        }

        this.requestIdToCompletion.delete(requestId);
        if (completion.input.type === 'dispose-workflow') {
          this.workflowRunIds.delete(completion.input.runId);
        }
        completion.resolve(result.output);
      }
    );
    workerThread.on('error', (err) => {
      logger.warn(`Workflow Worker Thread failed and will be replaced: ${err}`, { error: err });
      this.exitError = new WorkflowThreadLostError(`Workflow Worker Thread exited prematurely: ${err}`, err);
      // Node will automatically terminate the Worker Thread, immediately after this event.
    });
    workerThread.on('exit', (exitCode) => {
      logger.trace(`Workflow Worker Thread exited with code ${exitCode}`, { exitError: this.exitError });
      this.workerExited = true;

      const error: WorkflowThreadLostError =
        this.exitError ??
        new WorkflowThreadLostError('Workflow Worker Thread exited while there were still pending completions', {
          shutDownRequested: this.shutDownRequested,
        });

      const completions = this.requestIdToCompletion.values();
      this.requestIdToCompletion = new Map();
      for (const completion of completions) {
        completion.reject(error);
      }
      const runIds = Array.from(this.workflowRunIds);
      this.workflowRunIds.clear();
      if (!this.shutDownRequested) this.onUnexpectedExit?.(this, runIds, error);
    });
  }

  private handlePatchActivationCallback(request: PatchActivationCallbackRequest): void {
    try {
      if (this.patchActivationCallback === undefined) {
        throw new IllegalStateError('Received patch activation callback request without a configured callback');
      }
      const result = invokePatchActivationCallbackWithSnapshot(
        this.patchActivationCallback,
        request.workflowInfo,
        request.patchId
      );
      writePatchActivationCallbackResult(request.resultBuffer, result);
    } catch (err) {
      writePatchActivationCallbackError(request.resultBuffer, err);
      this.logger.warn('Patch activation callback failed', {
        error: err,
        workflowId: request.workflowInfo.workflowId,
        runId: request.workflowInfo.runId,
        workflowType: request.workflowInfo.workflowType,
        patchId: request.patchId,
      });
    } finally {
      completePatchActivationCallback(request.resultBuffer);
    }
  }

  /**
   * Send input to Worker thread and await for output
   */
  async send(input: WorkerThreadInput): Promise<WorkerThreadOutput> {
    // Reserve new runs before checking exitError so the imminent exit event includes an init activation that raced
    // with the thread's error event. Core must invalidate that activation too, even though it was never posted.
    if (input.type === 'create-workflow' && !this.workerExited) {
      this.workflowRunIds.add(input.options.info.runId);
    }
    if (this.exitError || this.workerExited) {
      throw this.exitError ?? new WorkflowThreadLostError('Received request after worker thread exited');
    }
    const requestId = this.requestIdx++;
    const request: WorkerThreadRequest = { requestId, input };
    const result = new Promise<WorkerThreadOutput>((resolve, reject) => {
      this.requestIdToCompletion.set(requestId, { input, resolve, reject });
    });
    try {
      // Transfer ownership of activation buffer for zero-copy transfer
      if (request.input.type === 'activate-workflow' && request.input.activation instanceof Uint8Array) {
        this.workerThread.postMessage(request, [request.input.activation.buffer]);
      } else {
        this.workerThread.postMessage(request);
      }
    } catch (err) {
      this.requestIdToCompletion.delete(requestId);
      if (request.input.type === 'create-workflow') {
        this.workflowRunIds.delete(request.input.options.info.runId);
      }
      throw err;
    }
    return result;
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

    const exitCode = await (isBunPre1_4 ? this.terminateWithBunWorkaround() : this.workerThread.terminate());
    if (exitCode !== null && exitCode !== TERMINATED_EXIT_CODE) {
      throw new UnexpectedError(`Failed to terminate Worker thread, exit code: ${exitCode}`);
    }
  }

  /**
   * Bun's terminate() hangs when called on an already exited worker thread.
   * We race terminate() against receiving the exit event to handle this case.
   */
  private async terminateWithBunWorkaround(): Promise<number | null> {
    const pollIntervalMs = 100;

    const terminatePromise = this.workerThread.terminate();

    let result = null;
    while (!this.workerExited) {
      result = await Promise.race([terminatePromise, setTimeout(pollIntervalMs, null)]);
    }

    return result;
  }

  public getActiveWorkflowCount(): number {
    return this.workflowRunIds.size;
  }
}

export interface ThreadedVMWorkflowCreatorOptions {
  workflowBundle: WorkflowBundleWithSourceMapAndFilename;
  threadPoolSize: number;
  isolateExecutionTimeoutMs: number;
  reuseV8Context: boolean;
  registeredActivityNames: Set<string>;
  logger: Logger;
  patchActivationCallback?: PatchActivationCallback;
  maxWorkflowThreadHeapMiB?: number;
}

/**
 * A WorkflowCreator that creates vm Workflows inside Worker threads
 */
export class ThreadedVMWorkflowCreator implements WorkflowCreator {
  /**
   * Create an instance of ThreadedVMWorkflowCreator asynchronously.
   *
   * This method creates and initializes the workflow-worker-thread instances.
   */
  static async create(options: ThreadedVMWorkflowCreatorOptions): Promise<ThreadedVMWorkflowCreator> {
    const creator = new this(options);
    try {
      await creator.initialize();
      return creator;
    } catch (err) {
      await creator.destroy();
      throw err;
    }
  }

  protected readonly workerThreadClients: Array<WorkerThreadClient | undefined>;
  private readonly initializingClients = new Set<WorkerThreadClient>();
  private readonly replacementPromises = new Map<number, Promise<void>>();
  private readonly pendingEvictionEvents: WorkflowThreadEvictionEvent[] = [];
  private readonly pendingFatalErrors: Error[] = [];
  private destroyed = false;
  private evictionHandler?: (event: WorkflowThreadEvictionEvent) => void;
  private fatalErrorHandler?: (error: Error) => void;

  protected constructor(protected readonly options: ThreadedVMWorkflowCreatorOptions) {
    this.workerThreadClients = new Array(options.threadPoolSize);
  }

  private async initialize(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from({ length: this.options.threadPoolSize }, (_, index) => this.spawnWorkerThread(index))
    );
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure !== undefined) throw failure.reason;
  }

  private async spawnWorkerThread(index: number): Promise<void> {
    const { logger, patchActivationCallback, maxWorkflowThreadHeapMiB } = this.options;
    const workerThread = new NodeWorker(
      require.resolve('./workflow-worker-thread'),
      maxWorkflowThreadHeapMiB === undefined
        ? undefined
        : { resourceLimits: { maxOldGenerationSizeMb: maxWorkflowThreadHeapMiB } }
    );
    const client = new WorkerThreadClient(
      workerThread,
      logger,
      patchActivationCallback,
      (notification) => this.handleHeapEvictions(notification),
      (exitedClient, runIds, error) => this.handleUnexpectedExit(index, exitedClient, runIds, error)
    );
    this.initializingClients.add(client);
    try {
      const init: Init = {
        type: 'init',
        workflowBundle: this.options.workflowBundle,
        isolateExecutionTimeoutMs: this.options.isolateExecutionTimeoutMs,
        reuseV8Context: this.options.reuseV8Context,
        registeredActivityNames: this.options.registeredActivityNames,
        hasPatchActivationCallback: patchActivationCallback !== undefined,
        heapSizeLimitBytes: maxWorkflowThreadHeapMiB === undefined ? undefined : maxWorkflowThreadHeapMiB * MiB,
      };
      await client.send(init);
      if (this.destroyed) {
        await client.destroy();
      } else {
        this.workerThreadClients[index] = client;
      }
    } catch (err) {
      await client.destroy().catch(() => undefined);
      throw err;
    } finally {
      this.initializingClients.delete(client);
    }
  }

  private handleHeapEvictions(notification: WorkflowEvictionNotification): void {
    this.emitEvictions({
      runIds: notification.runIds,
      reason: 'heap-pressure',
      usedHeapSize: notification.usedHeapSize,
      heapSizeLimit: notification.heapSizeLimit,
    });
  }

  private handleUnexpectedExit(
    index: number,
    client: WorkerThreadClient,
    runIds: string[],
    error: WorkflowThreadLostError
  ): void {
    if (this.destroyed || this.initializingClients.has(client) || this.workerThreadClients[index] !== client) return;

    this.workerThreadClients[index] = undefined;
    if (runIds.length > 0) this.emitEvictions({ runIds, reason: 'thread-exit' });
    this.options.logger.warn('Replacing failed Workflow Worker Thread', {
      error,
      affectedWorkflowCount: runIds.length,
    });

    const replacement = this.spawnWorkerThread(index)
      .catch((replacementError) => {
        const error = new UnexpectedError('Failed to replace Workflow Worker Thread', replacementError);
        if (this.fatalErrorHandler === undefined) this.pendingFatalErrors.push(error);
        else this.fatalErrorHandler(error);
      })
      .finally(() => this.replacementPromises.delete(index));
    this.replacementPromises.set(index, replacement);
  }

  private emitEvictions(event: WorkflowThreadEvictionEvent): void {
    if (this.evictionHandler === undefined) this.pendingEvictionEvents.push(event);
    else this.evictionHandler(event);
  }

  /** Connect thread-local lifecycle events after the native Core Worker has been constructed. */
  setLifecycleHandlers(
    evictionHandler: (event: WorkflowThreadEvictionEvent) => void,
    fatalErrorHandler: (error: Error) => void
  ): void {
    this.evictionHandler = evictionHandler;
    this.fatalErrorHandler = fatalErrorHandler;
    for (const event of this.pendingEvictionEvents.splice(0)) evictionHandler(event);
    for (const error of this.pendingFatalErrors.splice(0)) fatalErrorHandler(error);
  }

  /**
   * Create a workflow with given options
   */
  async createWorkflow(options: WorkflowCreateOptions): Promise<Workflow> {
    for (;;) {
      const availableClients = this.workerThreadClients.filter(
        (client): client is WorkerThreadClient => client !== undefined
      );
      if (availableClients.length > 0) {
        const workerThreadClient = availableClients.reduce((prev, curr) =>
          prev.getActiveWorkflowCount() < curr.getActiveWorkflowCount() ? prev : curr
        );
        return await VMWorkflowThreadProxy.create(workerThreadClient, options);
      }
      if (this.replacementPromises.size === 0) {
        throw new UnexpectedError('No Workflow Worker Threads are available');
      }
      await Promise.race(this.replacementPromises.values());
    }
  }

  /**
   * Destroy and terminate all threads created by this instance
   */
  async destroy(): Promise<void> {
    this.destroyed = true;
    await Promise.all(this.replacementPromises.values());
    await Promise.all(this.workerThreadClients.map((client) => client?.destroy()));
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
    // Delete .now and .random because functions can't be serialized / sent to thread.
    // Cast to any to avoid type errors, since both are required fields.
    // Safe to cast since we immediately reset them inside the thread in initRuntime.
    delete (options.info.unsafe as any).now;
    delete (options.info.unsafe as any).random;
    await workerThreadClient.send({ type: 'create-workflow', options });
    return new this(workerThreadClient, options.info.runId);
  }

  constructor(
    protected readonly workerThreadClient: WorkerThreadClient,
    public readonly runId: string
  ) {}

  /**
   * Proxy request to the VMWorkflow instance
   */
  async getAndResetSinkCalls(): Promise<SinkCall[]> {
    const output = await this.workerThreadClient.send({
      type: 'extract-sink-calls',
      runId: this.runId,
    });
    if (output?.type === 'workflow-locally-evicted') {
      throw new WorkflowLocallyEvictedError(`Workflow ${this.runId} was evicted by its Worker Thread`);
    }
    if (output?.type !== 'sink-calls') {
      throw new TypeError(`Got invalid response output from Workflow Worker thread ${output}`);
    }

    output.calls.forEach((call) => {
      (call.workflowInfo.unsafe.now as any) = Date.now;
      (call.workflowInfo.unsafe.random as any) = createUnsafeRandomSource(Math.random);
    });
    return output.calls;
  }

  /**
   * Proxy request to the VMWorkflow instance
   */
  async activate(
    activation: coresdk.workflow_activation.IWorkflowActivation
  ): Promise<coresdk.workflow_completion.IWorkflowActivationCompletion> {
    const output = await this.workerThreadClient.send({
      type: 'activate-workflow',
      // Before Bun 1.4.0, some activation messages get silently dropped by Bun's postMessage.
      // To work around this bug, we encode activations
      // An example of a failing activation can be found in test-payload-converter.ts 'Worker encodes/decodes a protobuf containing a binary array'
      activation: isBunPre1_4 ? coresdk.workflow_activation.WorkflowActivation.encode(activation).finish() : activation,
      runId: this.runId,
    });
    if (output?.type === 'workflow-locally-evicted') {
      throw new WorkflowLocallyEvictedError(`Workflow ${this.runId} was evicted by its Worker Thread`);
    }
    if (output?.type !== 'activation-completion') {
      throw new TypeError(`Got invalid response output from Workflow Worker thread ${output}`);
    }
    if (output.completion instanceof Uint8Array) {
      return coresdk.workflow_completion.WorkflowActivationCompletion.decode(output.completion);
    }
    return output.completion;
  }

  async activationCompletionAccepted(): Promise<void> {
    await this.workerThreadClient.send({ type: 'mark-workflow-idle', runId: this.runId });
  }

  /**
   * Proxy request to the VMWorkflow instance
   */
  async dispose(): Promise<void> {
    try {
      await this.workerThreadClient.send({ type: 'dispose-workflow', runId: this.runId });
    } catch (_e) {
      // Ignore errors when disposing
    }
  }
}
