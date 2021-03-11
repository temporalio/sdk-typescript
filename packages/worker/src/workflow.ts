import ivm from 'isolated-vm';
import dedent from 'dedent';
import { coresdk } from '@temporalio/proto';
import { activate, concludeActivation } from '@temporalio/workflow/commonjs/internals';
import { Loader } from './loader';

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
  activate: ivm.Reference<typeof activate>;
  concludeActivation: ivm.Reference<typeof concludeActivation>;
}

export class Workflow {
  private constructor(
    public readonly id: string,
    readonly isolate: ivm.Isolate,
    readonly context: ivm.Context,
    readonly loader: Loader,
    readonly workflowModule: WorkflowModule
  ) {}

  public static async create(id: string): Promise<Workflow> {
    const isolate = new ivm.Isolate();
    const context = await isolate.createContext();

    const runtimeModule = new ivm.NativeModule(
      require.resolve('../build/Release/temporalio-workflow-isolate-extension')
    );
    const runtime = await runtimeModule.create(context);

    const loader = new Loader(isolate, context);
    const protobufModule = await loader.loadModule(require.resolve('@temporalio/proto/es2020/protobuf.js'));
    loader.overrideModule('protobufjs/minimal', protobufModule);
    const protosModule = await loader.loadModule(require.resolve('@temporalio/proto/es2020/index.js'));
    loader.overrideModule('@temporalio/proto', protosModule);
    const workflowInternals = await loader.loadModule(require.resolve('@temporalio/workflow/es2020/internals.js'));
    const workflowModule = await loader.loadModule(require.resolve('@temporalio/workflow/es2020/index.js'));
    const activate = await workflowInternals.namespace.get('activate');
    const concludeActivation = await workflowInternals.namespace.get('concludeActivation');
    const initWorkflow = await workflowInternals.namespace.get('initWorkflow');
    loader.overrideModule('@temporalio/workflow', workflowModule);

    await initWorkflow.apply(undefined, [id, runtime.derefInto()], { arguments: { copy: true } });

    return new Workflow(id, isolate, context, loader, { activate, concludeActivation });
  }

  public async registerActivities(activities: Map<string, Record<string, any>>): Promise<void> {
    for (const [specifier, module] of activities.entries()) {
      let code = dedent`
        import { scheduleActivity } from '@temporalio/workflow';
      `;
      // TODO: inject options
      for (const [k, v] of Object.entries(module)) {
        if (v instanceof Function) {
          code += dedent`
            export function ${k}(...args) {
              return scheduleActivity('${specifier}', '${k}', args, {});
            }
            ${k}.module = '${specifier}';
            ${k}.options = {};
          `;
        }
      }
      const compiled = await this.loader.loadModuleFromSource(code, { path: specifier, type: 'esmodule' });
      this.loader.overrideModule(specifier, compiled);
    }
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

  public async activate(taskToken: Uint8Array, activation: coresdk.IWFActivation): Promise<Uint8Array> {
    if (!activation.jobs) {
      throw new Error('Expected workflow activation jobs to be defined');
    }
    const arr = coresdk.WFActivation.encodeDelimited(activation).finish();
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

  public async registerImplementation(path: string): Promise<void> {
    const mod = await this.loader.loadModule(path);
    this.loader.overrideModule('main', mod);
    const registerWorkflow = await this.loader.loadModule(
      require.resolve('@temporalio/workflow/es2020/register-workflow.js')
    );
    const run = await registerWorkflow.namespace.get('run');
    await run.apply(undefined, [], {});
  }
}
