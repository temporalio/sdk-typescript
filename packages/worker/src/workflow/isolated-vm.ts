import ivm from 'isolated-vm';
import dedent from 'dedent';
import { coresdk } from '@temporalio/proto';
import * as internals from '@temporalio/workflow/lib/worker-interface';
import { SinkFunction, WorkflowInfo, SinkCall } from '@temporalio/workflow';
import { partition } from '../utils';
import { Workflow, WorkflowCreateOptions, WorkflowCreator } from './interface';

/**
 * Controls how an injected function is executed.
 *
 * Functions are injected into the isolate using an {@link https://github.com/laverdet/isolated-vm#referenceapplyreceiver-arguments-options-promise | isolated-vm Reference}
 */
export enum ApplyMode {
  /**
   * Injected function is called synchronously, implementation must be a synchronous function.
   * Function is called with `applySync`.
   */
  SYNC = 'applySync',
  /**
   * Injected function is called synchronously, implementation must return a promise.
   * Function is called with `applySyncPromise`.
   */
  SYNC_PROMISE = 'applySyncPromise',
  /**
   * Injected function is called in the background not blocking the isolate.
   * Implementation can be either synchronous or asynchronous.
   * Function is called with `applyIgnored`.
   *
   * This is the safest sync `ApplyMode` because it can not break Workflow code determinism.
   */
  SYNC_IGNORED = 'applyIgnored',
}

/**
 * Typed accessor into the workflow isolate's worker-interface exported functions.
 */
interface WorkflowModule {
  activate: ivm.Reference<typeof internals.activate>;
  concludeActivation: ivm.Reference<typeof internals.concludeActivation>;
  getAndResetSinkCalls: ivm.Reference<typeof internals.getAndResetSinkCalls>;
  tryUnblockConditions: ivm.Reference<typeof internals.tryUnblockConditions>;
}

// Shared native isolate extension module for all isolates, needs to be injected into each Workflow's V8 context.
const isolateExtensionModule = new ivm.NativeModule(
  require.resolve('../../build/Release/temporalio-workflow-isolate-extension')
);

export class IsolatedVMWorkflowCreator implements WorkflowCreator {
  nextIsolateIdx = 0;

  constructor(
    readonly isolates: ivm.Isolate[],
    readonly scripts: ivm.Script[],
    readonly poolSize: number,
    readonly isolateExecutionTimeoutMs: number
  ) {}

  static async create<T extends typeof IsolatedVMWorkflowCreator>(
    this: T,
    poolSize: number,
    isolateExecutionTimeoutMs: number,
    maxIsolateMemoryMB: number,
    code: string
  ): Promise<InstanceType<T>> {
    const isolates = Array<ivm.Isolate>(poolSize);
    const scripts = Array<ivm.Script>(poolSize);

    for (let i = 0; i < poolSize; ++i) {
      const isolate = (isolates[i] = new ivm.Isolate({ memoryLimit: maxIsolateMemoryMB }));
      scripts[i] = await isolate.compileScript(code, { filename: 'workflow-isolate' });
    }
    return new this(isolates, scripts, poolSize, isolateExecutionTimeoutMs) as InstanceType<T>;
  }

  async getContext(): Promise<ivm.Context> {
    const isolateIdx = this.nextIsolateIdx;
    this.nextIsolateIdx = (this.nextIsolateIdx + 1) % this.poolSize;
    const isolate = this.isolates[isolateIdx];
    const script = this.scripts[isolateIdx];
    const context = await isolate.createContext();
    await script.run(context);
    return context;
  }

  /**
   * Inject a function into the isolate context global scope using an {@link https://github.com/laverdet/isolated-vm#referenceapplyreceiver-arguments-options-promise | isolated-vm Reference}
   *
   * @param path name of global variable to inject the function as (e.g. `console.log`)
   * @param fn function to inject into the isolate
   * @param applyMode controls how the injected reference will be called from the isolate (see link above)
   * @param transferOptions controls how arguments and return value are passes between the isolates
   */
  protected static async injectGlobal(
    context: ivm.Context,
    path: string,
    fn: () => any,
    applyMode: ApplyMode,
    transferOptions?: ivm.TransferOptionsBidirectional
  ): Promise<void> {
    transferOptions = addDefaultTransferOptions(applyMode, transferOptions);

    await context.evalClosure(
      dedent`
    globalThis.${path} = function(...args) {
      return $0.${applyMode}(
        undefined,
        args,
        ${JSON.stringify(transferOptions)},
      );
    }`,
      [fn],
      { arguments: { reference: true } }
    );
  }

  /**
   * Inject console.log into the Workflow isolate context.
   *
   * Overridable for test purposes.
   */
  protected async injectConsole(context: ivm.Context, info: WorkflowInfo): Promise<void> {
    await IsolatedVMWorkflowCreator.injectGlobal(
      context,
      'console.log',
      (...args: any[]) => {
        // info.isReplaying is mutated by the Workflow class on activation
        if (info.isReplaying) return;
        console.log(`[${info.workflowType}(${info.workflowId})]`, ...args);
      },
      ApplyMode.SYNC
    );
  }

  async createWorkflow(options: WorkflowCreateOptions): Promise<Workflow> {
    const context = await this.getContext();
    await this.injectConsole(context, options.info);
    return await IsolatedVMWorkflow.create(context, options, this.isolateExecutionTimeoutMs);
  }

  async destroy(): Promise<void> {
    for (const script of this.scripts) {
      script.release();
    }
    for (const isolate of this.isolates) {
      isolate.dispose();
    }
  }
}

export class IsolatedVMWorkflow implements Workflow {
  private constructor(
    public readonly info: WorkflowInfo,
    readonly context: ivm.Context,
    readonly workflowModule: WorkflowModule,
    public readonly isolateExecutionTimeoutMs: number,
    readonly sinks: Record<string, Record<string, SinkFunction>> = {}
  ) {}

  public static async create(
    context: ivm.Context,
    options: WorkflowCreateOptions,
    isolateExecutionTimeoutMs: number
  ): Promise<IsolatedVMWorkflow> {
    const [activate, concludeActivation, getAndResetSinkCalls, tryUnblockConditions, isolateExtension] =
      await Promise.all(
        ['activate', 'concludeActivation', 'getAndResetSinkCalls', 'tryUnblockConditions']
          .map((fn) =>
            context.eval(`lib.${fn}`, {
              reference: true,
              timeout: isolateExecutionTimeoutMs,
            })
          )
          .concat(isolateExtensionModule.create(context))
      );

    await context.evalClosure('lib.initRuntime($0, $1)', [options, isolateExtension.derefInto()], {
      arguments: { copy: true },
      timeout: isolateExecutionTimeoutMs,
    });

    return new this(
      options.info,
      context,
      {
        activate,
        concludeActivation,
        getAndResetSinkCalls,
        tryUnblockConditions,
      },
      isolateExecutionTimeoutMs
    );
  }

  async getAndResetSinkCalls(): Promise<SinkCall[]> {
    return await this.workflowModule.getAndResetSinkCalls.apply(undefined, [], {
      arguments: { copy: true },
      result: { copy: true },
      timeout: this.isolateExecutionTimeoutMs,
    });
  }

  public async activate(activation: coresdk.workflow_activation.IWFActivation): Promise<Uint8Array> {
    this.info.isReplaying = activation.isReplaying ?? false;
    if (!activation.jobs) {
      throw new Error('Expected workflow activation jobs to be defined');
    }

    // Job processing order
    // 1. patch notifications
    // 2. signals
    // 3. anything left except for queries
    // 4. queries
    const [patches, nonPatches] = partition(activation.jobs, ({ notifyHasPatch }) => notifyHasPatch != null);
    const [signals, nonSignals] = partition(nonPatches, ({ signalWorkflow }) => signalWorkflow != null);
    const [queries, rest] = partition(nonSignals, ({ queryWorkflow }) => queryWorkflow != null);
    let batchIndex = 0;

    // Loop and invoke each batch and wait for microtasks to complete.
    // This is done outside of the isolate because we can't wait for microtasks from inside the isolate.
    for (const jobs of [patches, signals, rest, queries]) {
      if (jobs.length === 0) {
        continue;
      }
      const arr = coresdk.workflow_activation.WFActivation.encodeDelimited({ ...activation, jobs }).finish();
      const { numBlockedConditions } = await this.workflowModule.activate.apply(undefined, [arr, batchIndex++], {
        arguments: { copy: true },
        result: { copy: true, promise: true },
        timeout: this.isolateExecutionTimeoutMs,
      });
      // Microtasks will already have run at this point

      if (numBlockedConditions > 0) {
        await this.tryUnblockConditions();
      }
    }
    return await this.workflowModule.concludeActivation.apply(undefined, [], {
      arguments: { copy: true },
      result: { copy: true },
      timeout: this.isolateExecutionTimeoutMs,
    });
  }

  protected async tryUnblockConditions(): Promise<void> {
    for (;;) {
      const numUnblocked = await this.workflowModule.tryUnblockConditions.apply(undefined, [], {
        result: { copy: true },
        timeout: this.isolateExecutionTimeoutMs,
      });
      if (numUnblocked === 0) break;
    }
  }

  /**
   * Dispose of the isolate's context.
   * Do not use this Workflow instance after this method has been called.
   */
  public async dispose(): Promise<void> {
    for (const v of Object.values(this.workflowModule)) {
      v.release();
    }
    this.context.release();
  }
}

/** Adds defaults to `transferOptions` for given `applyMode` */
function addDefaultTransferOptions(
  applyMode: ApplyMode,
  transferOptions?: ivm.TransferOptionsBidirectional
): ivm.TransferOptionsBidirectional {
  let defaultTransferOptions: ivm.TransferOptionsBidirectional;
  if (applyMode === ApplyMode.SYNC_PROMISE) {
    defaultTransferOptions = { arguments: { copy: true } };
  } else {
    defaultTransferOptions = { arguments: { copy: true }, result: { copy: true } };
  }
  return { ...defaultTransferOptions, ...transferOptions };
}
