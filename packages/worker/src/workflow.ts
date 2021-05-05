import ivm from 'isolated-vm';
import Long from 'long';
import dedent from 'dedent';
import { coresdk } from '@temporalio/proto';
import * as internals from '@temporalio/workflow/commonjs/internals';
import * as init from '@temporalio/workflow/commonjs/init';

export enum ApplyMode {
  ASYNC = 'apply',
  SYNC = 'applySync',
  IGNORED = 'applyIgnored',
  SYNC_PROMISE = 'applySyncPromise',
}

const AsyncFunction = Object.getPrototypeOf(async function () {
  return 0;
}).constructor;

interface WorkflowModule {
  activate: ivm.Reference<typeof internals.activate>;
  concludeActivation: ivm.Reference<typeof internals.concludeActivation>;
}

// Shared runtime module for all isolates, needs to be created in context.
const runtimeModule = new ivm.NativeModule(require.resolve('../build/Release/temporalio-workflow-isolate-extension'));

export class Workflow {
  private constructor(
    public readonly id: string,
    readonly isolate: ivm.Isolate,
    readonly context: ivm.Context,
    readonly workflowModule: WorkflowModule
  ) {}

  public static async create(
    isolate: ivm.Isolate,
    name: string,
    id: string,
    randomnessSeed: Long,
    taskQueue: string
  ): Promise<Workflow> {
    const context = await isolate.createContext();

    const runtime = await runtimeModule.create(context);

    const activate: WorkflowModule['activate'] = await context.eval(`lib.internals.activate`, {
      reference: true,
    });
    const concludeActivation: WorkflowModule['concludeActivation'] = await context.eval(
      `lib.internals.concludeActivation`,
      { reference: true }
    );
    const initWorkflow: ivm.Reference<typeof init.initWorkflow> = await context.eval(`lib.init.initWorkflow`, {
      reference: true,
    });

    await initWorkflow.apply(undefined, [id, randomnessSeed.toBytes(), taskQueue, runtime.derefInto()], {
      arguments: { copy: true },
    });
    await context.eval(
      dedent`
      const mod = lib.workflows[${JSON.stringify(name)}];
      if (mod === undefined) {
        throw new ReferenceError('Workflow not found');
      }
      lib.init.registerWorkflow(mod.workflow || mod);
      `
    );

    return new Workflow(id, isolate, context, { activate, concludeActivation });
  }

  public async inject(
    path: string,
    handler: () => any,
    applyMode?: ApplyMode,
    transferOptions?: ivm.TransferOptionsBidirectional
  ): Promise<void> {
    transferOptions = { arguments: { copy: true }, result: { copy: true }, ...transferOptions };

    if (applyMode === undefined) {
      if (handler instanceof AsyncFunction) {
        applyMode = ApplyMode.SYNC_PROMISE;
      } else {
        applyMode = ApplyMode.SYNC;
      }
    }
    if (applyMode === ApplyMode.SYNC_PROMISE) {
      delete transferOptions.result;
    }

    await this.context.evalClosure(
      dedent`
    globalThis.${path} = function(...args) {
      return $0.${applyMode}(
        undefined,
        args,
        ${JSON.stringify(transferOptions)},
      );
    }`,
      [handler],
      { arguments: { reference: true } }
    );
  }

  public async activate(
    taskToken: Uint8Array,
    activation: coresdk.workflow_activation.IWFActivation
  ): Promise<Uint8Array> {
    if (!activation.jobs) {
      throw new Error('Expected workflow activation jobs to be defined');
    }
    const arr = coresdk.workflow_activation.WFActivation.encodeDelimited(activation).finish();
    // Loop and invoke each job with entire microtasks chain.
    // This is done outside of the isolate because we can't wait for microtasks from inside the isolate.
    // TODO: Process signals first
    for (let idx = 0; idx < activation.jobs.length; ++idx) {
      const processed = await this.workflowModule.activate.apply(undefined, [arr, idx], {
        arguments: { copy: true },
        result: { copy: true },
      });
      // Microtasks will already have run at this point
      if (!processed) {
        // TODO: Log?
      }
    }
    return this.workflowModule.concludeActivation.apply(undefined, [taskToken], {
      arguments: { copy: true },
      result: { copy: true },
    }) as Promise<Uint8Array>;
  }

  /**
   * Dispose of the isolate's context.
   * Do not use this Workflow instance after this method has been called.
   */
  public dispose(): void {
    this.workflowModule.concludeActivation.release();
    this.workflowModule.activate.release();
    this.context.release();
  }
}
