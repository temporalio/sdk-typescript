import { coresdk } from '@temporalio/proto';
import { IllegalStateError, WorkflowInfo, SinkCall } from '@temporalio/workflow';
import { Worker } from 'worker_threads';
import { Workflow, WorkflowCreator, WorkflowCreateOptions } from './interface';
import { WorkerThreadInput, WorkerThreadRequest } from './workflow-worker-thread/input';
import { WorkerThreadOutput, WorkerThreadResponse } from './workflow-worker-thread/output';

interface Completion<T> {
  resolve(value: T): void;
  reject(error: any): void;
}

interface ErrorConstructor {
  new (message: string): Error;
}

function errorNameToClass(name: string): ErrorConstructor {
  switch (name) {
    case 'IllegalStateError':
      return IllegalStateError;
    default:
      return Error;
  }
}

export class WorkerThreadClient {
  requestIdx = 0n;
  requestIdToCompletion = new Map<BigInt, Completion<WorkerThreadOutput>>();

  constructor(protected readonly workerThread: Worker) {
    workerThread.on('message', ({ requestId, result }: WorkerThreadResponse) => {
      const completion = this.requestIdToCompletion.get(requestId);
      if (completion === undefined) {
        // TODO: log
        return;
      }
      if (result.type === 'error') {
        const ctor = errorNameToClass(result.name);
        const err = new ctor(result.message);
        err.stack = result.stack;
        completion.reject(err);
        return;
      }

      completion.resolve(result.output);
    });
  }

  async send(input: WorkerThreadInput): Promise<WorkerThreadOutput> {
    const requestId = this.requestIdx++;
    const request: WorkerThreadRequest = { requestId, input };
    this.workerThread.postMessage(request);
    const promise = new Promise<WorkerThreadOutput>((resolve, reject) => {
      this.requestIdToCompletion.set(requestId, { resolve, reject });
    });
    return promise;
  }

  async destroy(): Promise<void> {
    await this.send({ type: 'destroy' });
    // TODO: figure this out
    this.workerThread.unref();
  }
}

export class ThreadedVMWorkflowCreator implements WorkflowCreator {
  protected workflowThreadIdx = 0;
  protected runIdToThreadNum = new Map<string, number>();

  static async create(
    threadPoolSize: number,
    code: string,
    isolateExecutionTimeoutMs: number
  ): Promise<ThreadedVMWorkflowCreator> {
    const workerThreadClients = Array(threadPoolSize)
      .fill(0)
      .map(() => new WorkerThreadClient(new Worker(require.resolve('./workflow-worker-thread'))));
    await Promise.all(
      workerThreadClients.map((client) => client.send({ type: 'init', code, isolateExecutionTimeoutMs }))
    );
    return new this(workerThreadClients);
  }

  constructor(protected readonly workerThreadClients: WorkerThreadClient[]) {}

  async createWorkflow(options: WorkflowCreateOptions): Promise<Workflow> {
    const workflowThreadIdx = this.workflowThreadIdx;
    const { runId } = options.info;
    this.runIdToThreadNum.set(runId, workflowThreadIdx);
    const workflow = await VMWorkflowThreadProxy.create(this.workerThreadClients[workflowThreadIdx], options);
    this.workflowThreadIdx = (this.workflowThreadIdx + 1) % this.workerThreadClients.length;
    return workflow;
  }

  async destroy(): Promise<void> {
    await Promise.all(this.workerThreadClients.map((client) => client.destroy()));
  }
}

export class VMWorkflowThreadProxy implements Workflow {
  static async create(
    workerThreadClient: WorkerThreadClient,
    options: WorkflowCreateOptions
  ): Promise<VMWorkflowThreadProxy> {
    await workerThreadClient.send({ type: 'create-workflow', options });
    return new this(workerThreadClient, options.info.runId);
  }

  constructor(protected readonly workerThreadClient: WorkerThreadClient, public readonly runId: string) {}

  async getAndResetSinkCalls(): Promise<SinkCall[]> {
    const output = await this.workerThreadClient.send({
      type: 'exteract-sink-calls',
      runId: this.runId,
    });
    if (!(output?.type === 'sink-calls')) {
      throw new TypeError(`Got invalid response output from Workflow Worker thread ${output}`);
    }
    return output.calls;
  }

  async activate(activation: coresdk.workflow_activation.IWFActivation): Promise<Uint8Array> {
    const arr = coresdk.workflow_activation.WFActivation.encodeDelimited(activation).finish();
    const output = await this.workerThreadClient.send({
      type: 'activate-workflow',
      activation: arr,
      runId: this.runId,
    });
    if (!(output?.type === 'activation-completion')) {
      throw new TypeError(`Got invalid response output from Workflow Worker thread ${output}`);
    }
    return output.completion;
  }

  async dispose(): Promise<void> {
    await this.workerThreadClient.send({ type: 'dispose-workflow', runId: this.runId });
  }
}
