import { setImmediate as hostImmediate } from 'node:timers';
import { defaultFailureConverter, defaultPayloadConverter } from '@temporalio/common';
import { native } from '@temporalio/core-bridge';
import { coresdk } from '@temporalio/proto';
import type { SinkCall } from '@temporalio/workflow';
import type { Activator } from '@temporalio/workflow/internal';
import type { Workflow, WorkflowCreateOptions, WorkflowCreator } from './interface';
import type { WorkflowPatchActivationCallback } from './patch-activation-callback';
import type { WorkflowBundleWithSourceMapAndFilename } from './workflow-worker-thread/input';
import { loadVmlessBundle } from './vmless-bundle';
import { prepareNonQueryActivation, prepareActivationBatches, partition } from './activation';

const hostTurn = () => new Promise<void>((resolve) => hostImmediate(resolve));

/** Execution in the thread's ordinary realm, without VM isolation or timeouts. */
export class VmlessWorkflowCreator implements WorkflowCreator {
  readonly workflowByRunId = new Map<string, VmlessWorkflow>();
  private readonly bundle;
  private destroyed = false;
  private readonly onUnhandledRejection = (error: unknown): never => {
    throw error;
  };

  constructor(
    private readonly workflowBundle: WorkflowBundleWithSourceMapAndFilename,
    private readonly registeredActivityNames: Set<string>,
    private readonly patchActivationCallback?: WorkflowPatchActivationCallback
  ) {
    this.bundle = loadVmlessBundle(workflowBundle);
    process.on('unhandledRejection', this.onUnhandledRejection);
  }

  async createWorkflow(options: WorkflowCreateOptions): Promise<Workflow> {
    if (this.destroyed) throw new Error('VM-less workflow creator was destroyed');
    const activator = this.bundle.api.initRuntime(
      {
        ...options,
        sourceMap: this.workflowBundle.sourceMap,
        getTimeOfDay: native.getTimeOfDay,
        registeredActivityNames: this.registeredActivityNames,
        stackTracesEnabled: false,
        showStackTraceSources: false,
        patchActivationCallback: this.patchActivationCallback
          ? (info, patchId) =>
              this.bundle.api.runOutsideWorkflowContext(() => this.patchActivationCallback!(info, patchId))
          : undefined,
      },
      this.bundle,
      (activator, error) => {
        if (this.bundle.api.isDisposed(activator)) {
          // No activation can report this error after eviction. Schedule the
          // fatal error outside workflow context without rejecting the observer.
          this.bundle.api.runOutsideWorkflowContext(() =>
            hostImmediate(() => {
              throw error;
            })
          );
        } else if (activator.workflowTaskError === undefined) {
          // Do not call recordWorkflowTaskError: it can synchronously rethrow.
          // Its reader tests truthiness, so preserve falsy rejection values as
          // a cause rather than losing the failure.
          activator.workflowTaskError =
            error || new Error(`SDK-owned asynchronous operation rejected with ${String(error)}`, { cause: error });
        }
      }
    );
    const workflow = new VmlessWorkflow(activator, this.bundle.api, () =>
      this.workflowByRunId.delete(options.info.runId)
    );
    this.workflowByRunId.set(options.info.runId, workflow);
    return workflow;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      await Promise.all([...this.workflowByRunId.values()].map((workflow) => workflow.dispose()));
    } finally {
      process.off('unhandledRejection', this.onUnhandledRejection);
    }
  }
}

class VmlessWorkflow implements Workflow {
  constructor(
    private readonly activator: Activator,
    private readonly runtime: ReturnType<typeof loadVmlessBundle>['api'],
    private readonly onDispose: () => void
  ) {}

  async getAndResetSinkCalls(): Promise<SinkCall[]> {
    return this.activator.getAndResetSinkCalls();
  }

  async activate(
    activation: coresdk.workflow_activation.IWorkflowActivation
  ): Promise<coresdk.workflow_completion.IWorkflowActivationCompletion> {
    const { activator, runtime } = this;
    return runtime.runWithActivator(activator, async () => {
      try {
        if (!activation.jobs) throw new TypeError('Expected workflow activation jobs to be defined');
        const [queries, nonQueries] = partition(activation.jobs, (job) => job.queryWorkflow != null);
        if (queries.length) {
          if (nonQueries.length) throw new TypeError('Got both queries and other jobs in a single activation');
          activator.mutateWorkflowInfo((info) => ({
            ...info,
            unsafe: { ...info.unsafe, isReplaying: true, isReplayingHistoryEvents: false },
          }));
          runtime.activate(activator, activation);
          await this.checkpoint();
          return await this.conclude();
        }

        prepareNonQueryActivation(activator, activation);
        const initialize = activation.jobs.find((job) => job.initializeWorkflow != null)?.initializeWorkflow;
        if (initialize) {
          runtime.initialize(activator, initialize);
          await this.checkpoint();
        }
        let batchIndex = 0;
        for (const jobs of prepareActivationBatches(activator, activation.jobs)) {
          runtime.activate(
            activator,
            coresdk.workflow_activation.WorkflowActivation.fromObject({ ...activation, jobs }),
            batchIndex++
          );
          await this.drain();
        }
        return await this.conclude();
      } catch (error) {
        try {
          return { runId: activator.info.runId, failed: { failure: activator.errorToFailure(error) } };
        } catch (conversionError) {
          // A broken custom converter must still produce a task failure, not
          // escape error reporting or recursively invoke the same converter.
          return {
            runId: activator.info.runId,
            failed: {
              failure: defaultFailureConverter.errorToFailure(conversionError, defaultPayloadConverter),
            },
          };
        }
      }
    });
  }

  private checkpoint(): Promise<void> {
    return this.runtime.runOutsideWorkflowContext(hostTurn);
  }

  private async drain(): Promise<void> {
    for (;;) {
      await this.checkpoint();
      if (this.runtime.tryUnblockConditions(this.activator) === 0) return;
    }
  }

  private async conclude(): Promise<coresdk.workflow_completion.IWorkflowActivationCompletion> {
    this.activator.maybeRethrowWorkflowTaskError();
    const completion = this.runtime.concludeActivation(this.activator);
    await this.checkpoint();
    this.activator.maybeRethrowWorkflowTaskError();
    return completion;
  }

  async dispose(): Promise<void> {
    if (this.runtime.isDisposed(this.activator)) return;
    try {
      this.runtime.runWithActivator(this.activator, () => this.runtime.dispose(this.activator));
      await this.checkpoint();
    } finally {
      this.onDispose();
    }
  }
}
