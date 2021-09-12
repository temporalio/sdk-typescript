import ivm from 'isolated-vm';
import Long from 'long';
import dedent from 'dedent';
import { coresdk } from '@temporalio/proto';
import * as internals from '@temporalio/workflow/lib/worker-interface';
import { ExternalDependencyFunction, WorkflowInfo, ExternalCall } from '@temporalio/workflow';
import { ApplyMode } from './dependencies';
import { partition } from './utils';

interface WorkflowModule {
  activate: ivm.Reference<typeof internals.activate>;
  concludeActivation: ivm.Reference<typeof internals.concludeActivation>;
  inject: ivm.Reference<typeof internals.inject>;
  resolveExternalDependencies: ivm.Reference<typeof internals.resolveExternalDependencies>;
  getAndResetPendingExternalCalls: ivm.Reference<typeof internals.getAndResetPendingExternalCalls>;
}

// Shared native isolate extension module for all isolates, needs to be injected into each Workflow's V8 context.
const isolateExtensionModule = new ivm.NativeModule(
  require.resolve('../build/Release/temporalio-workflow-isolate-extension')
);

export class Workflow {
  private constructor(
    public readonly info: WorkflowInfo,
    readonly context: ivm.Context,
    readonly workflowModule: WorkflowModule,
    public readonly isolateExecutionTimeoutMs: number,
    readonly dependencies: Record<string, Record<string, ExternalDependencyFunction>> = {}
  ) {}

  public static async create(
    context: ivm.Context,
    info: WorkflowInfo,
    interceptorModules: string[],
    randomnessSeed: Long,
    job: coresdk.workflow_activation.IStartWorkflow,
    isolateExecutionTimeoutMs: number
  ): Promise<Workflow> {
    const [
      activate,
      concludeActivation,
      inject,
      resolveExternalDependencies,
      getAndResetPendingExternalCalls,
      isolateExtension,
    ] = await Promise.all(
      ['activate', 'concludeActivation', 'inject', 'resolveExternalDependencies', 'getAndResetPendingExternalCalls']
        .map((fn) =>
          context.eval(`lib.${fn}`, {
            reference: true,
            timeout: isolateExecutionTimeoutMs,
          })
        )
        .concat(isolateExtensionModule.create(context))
    );
    const arr = coresdk.workflow_activation.StartWorkflow.encodeDelimited(job).finish();

    await context.evalClosure(
      'lib.initRuntime($0, $1, $2, $3, $4)',
      [info, interceptorModules, randomnessSeed.toBytes(), isolateExtension.derefInto(), arr],
      { arguments: { copy: true }, timeout: isolateExecutionTimeoutMs }
    );
    return new Workflow(
      info,
      context,
      { activate, concludeActivation, inject, resolveExternalDependencies, getAndResetPendingExternalCalls },
      isolateExecutionTimeoutMs
    );
  }

  /**
   * Inject a function into the isolate global scope using an {@link https://github.com/laverdet/isolated-vm#referenceapplyreceiver-arguments-options-promise | isolated-vm Reference}
   *
   * @param path name of global variable to inject the function as (e.g. `console.log`)
   * @param fn function to inject into the isolate
   * @param applyMode controls how the injected reference will be called from the isolate (see link above)
   * @param transferOptions controls how arguments and return value are passes between the isolates
   */
  public async injectGlobal(
    path: string,
    fn: () => any,
    applyMode: ApplyMode.SYNC | ApplyMode.SYNC_PROMISE | ApplyMode.SYNC_IGNORED,
    transferOptions?: ivm.TransferOptionsBidirectional
  ): Promise<void> {
    transferOptions = addDefaultTransferOptions(applyMode, transferOptions);

    await this.context.evalClosure(
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
   * Inject an external dependency function into the isolate.
   *
   * Depending on `applyMode`, injection is done either using an {@link https://github.com/laverdet/isolated-vm#referenceapplyreceiver-arguments-options-promise | isolated-vm Reference} or by buffering calls in-isolate
   * and collecting them as part of Workflow activation.
   *
   * @param ifaceName name of the injected dependency interface (e.g. logger)
   * @param fnName name of the dependency interface function (e.g. info)
   * @param fn function to inject
   * @param applyMode controls how the injected function will be called from the isolate (see explanation above)
   * @param transferOptions controls how arguments and return value are passes between the isolates (`SYNC*` apply modes only)
   */
  public async injectDependency(
    ifaceName: string,
    fnName: string,
    fn: (...args: any[]) => any,
    applyMode: ApplyMode,
    transferOptions?: ivm.TransferOptionsBidirectional
  ): Promise<void> {
    if (applyMode === ApplyMode.ASYNC || applyMode === ApplyMode.ASYNC_IGNORED) {
      if (this.dependencies[ifaceName] === undefined) {
        this.dependencies[ifaceName] = {};
      }
      this.dependencies[ifaceName][fnName] = fn;
    }

    // Ignored in isolate for ASYNC* apply modes
    transferOptions = addDefaultTransferOptions(applyMode, transferOptions);

    await this.workflowModule.inject.apply(
      undefined,
      [ifaceName, fnName, new ivm.Reference(fn), applyMode, transferOptions],
      { arguments: { copy: true }, timeout: this.isolateExecutionTimeoutMs }
    );
  }

  /**
   * Call external dependency functions in the Node.js isolate as requested by the Workflow isolate.
   */
  protected async processExternalCalls(externalCalls: ExternalCall[], sendResultsBack: boolean): Promise<void> {
    const results = await Promise.all(
      externalCalls.map(async ({ ifaceName, fnName, args, seq }) => {
        const fn = this.dependencies[ifaceName]?.[fnName];
        if (fn === undefined) {
          throw new TypeError(`Tried to call unregistered external dependency function ${ifaceName}.${fnName}`);
        }
        try {
          const result = await fn(...args);
          return { seq, error: undefined, result };
        } catch (error) {
          return { seq, error, result: undefined };
        }
      })
    );
    if (!sendResultsBack) {
      return;
    }
    const notIgnored = results.filter((r): r is internals.ExternalDependencyResult => r.seq !== undefined);
    if (notIgnored.length) {
      await this.workflowModule.resolveExternalDependencies.apply(undefined, [notIgnored], {
        arguments: { copy: true, timeout: this.isolateExecutionTimeoutMs },
      });
    }
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
    const [patches, nonPatches] = partition(activation.jobs, ({ notifyHasPatch }) => notifyHasPatch !== undefined);
    const [signals, nonSignals] = partition(nonPatches, ({ signalWorkflow }) => signalWorkflow !== undefined);
    const [queries, rest] = partition(nonSignals, ({ queryWorkflow }) => queryWorkflow !== undefined);
    let batchIndex = 0;

    try {
      // Loop and invoke each batch and wait for microtasks to complete.
      // This is done outside of the isolate because we can't wait for microtasks from inside the isolate.
      for (const jobs of [patches, signals, rest, queries]) {
        if (jobs.length === 0) {
          continue;
        }
        const arr = coresdk.workflow_activation.WFActivation.encodeDelimited({ ...activation, jobs }).finish();
        const pendingExternalCalls = await this.workflowModule.activate.apply(undefined, [arr, batchIndex++], {
          arguments: { copy: true },
          result: { copy: true, promise: true },
          timeout: this.isolateExecutionTimeoutMs,
        });
        // Microtasks will already have run at this point
        // Eagerly process external calls to unblock isolate and minimize the processing delay
        await this.processExternalCalls(pendingExternalCalls, true);
      }
      for (;;) {
        const conclusion = await this.workflowModule.concludeActivation.apply(undefined, [], {
          arguments: { copy: true },
          result: { copy: true },
          timeout: this.isolateExecutionTimeoutMs,
        });
        if (conclusion.type === 'pending') {
          await this.processExternalCalls(conclusion.pendingExternalCalls, true);
        } else {
          return conclusion.encoded;
        }
      }
    } catch (error) {
      // Make sure to flush out any external calls on failure
      const externalCalls = await this.workflowModule.getAndResetPendingExternalCalls.apply(undefined, [], {
        arguments: { copy: true },
        result: { copy: true },
        timeout: this.isolateExecutionTimeoutMs,
      });
      await this.processExternalCalls(externalCalls, false);
      throw error;
    }
  }

  /**
   * Dispose of the isolate's context.
   * Do not use this Workflow instance after this method has been called.
   */
  public dispose(): void {
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
