import { resolve as pathResolve } from 'path';
import ivm from 'isolated-vm';
import dedent from 'dedent';
import { coresdk } from '../proto/core-interface';
import { Loader } from './loader';

export enum ApplyMode {
  ASYNC = 'apply',
  SYNC = 'applySync',
  IGNORED = 'applyIgnored',
  SYNC_PROMISE = 'applySyncPromise',
}

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;

interface WorkflowModule {
  activate: ivm.Reference<Function>;
  concludeActivation: ivm.Reference<Function>;
}

export class Workflow {
  private readonly activities: Map<string, Map<string, Function>> = new Map();

  private constructor(
    public readonly id: string,
    readonly isolate: ivm.Isolate,
    readonly context: ivm.Context,
    readonly loader: Loader,
    readonly workflowModule: WorkflowModule,
  ) {
  }

  public static async create(id: string) {
    const isolate = new ivm.Isolate();
    const context = await isolate.createContext();
    const loader = new Loader(isolate, context);
    const protobufModule = await loader.loadModule(pathResolve(__dirname, '../proto/isolate/protobuf.js'));
    loader.overrideModule('protobufjs/minimal', protobufModule);
    const protosModule = await loader.loadModule(pathResolve(__dirname, '../proto/isolate/core-interface.js'));
    loader.overrideModule(pathResolve(__dirname, '../proto/core-interface.js'), protosModule);
    const workflowInternals = await loader.loadModule(pathResolve(__dirname, '../workflow-lib/lib/internals.js'));
    const workflowModule = await loader.loadModule(pathResolve(__dirname, '../workflow-lib/lib/workflow.js'));
    const activate = await workflowInternals.namespace.get('activate');
    const concludeActivation = await workflowInternals.namespace.get('concludeActivation');
    const initWorkflow = await workflowInternals.namespace.get('initWorkflow');
    loader.overrideModule('@temporal-sdk/workflow', workflowModule);

    await initWorkflow.apply(undefined, [id], { arguments: { copy: true } });

    return new Workflow(id, isolate, context, loader, { activate, concludeActivation });
  }

  public async registerActivities(activities: Record<string, Record<string, any>>) {
    for (const [specifier, module] of Object.entries(activities)) {
      const functions = new Map<string, Function>();
      let code = '';
      for (const [k, v] of Object.entries(module)) {
        if (v instanceof Function) {
          functions.set(k, v);
          code += dedent`
            export async function ${k}(...args) {
              return invokeActivity('${specifier}', '${k}', args, {});
            }
            ${k}.module = '${specifier}';
            ${k}.options = {};
          `
        }
      }
      const compiled = await this.isolate.compileModule(code, { filename: specifier });
      await compiled.instantiate(this.context, async () => { throw new Error('Invalid') });
      await compiled.evaluate();
      this.activities.set(specifier, functions);
      this.loader.overrideModule(specifier, compiled);
    }
  }

  public async inject(
    path: string,
    handler: Function,
    applyMode?: ApplyMode,
    transferOptions?: ivm.TransferOptionsBidirectional
  ) {
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

    await this.context.evalClosure(dedent`
    globalThis.${path} = function(...args) {
      return $0.${applyMode}(
        undefined,
        args,
        ${JSON.stringify(transferOptions)},
      );
    }`, [handler], { arguments: { reference: true } });
  }

  public async activate(taskToken: Uint8Array, activation: coresdk.IWFActivation) {
    if (!activation.jobs) {
      throw new Error('Expected workflow activation jobs to be defined');
    }
    const arr = coresdk.WFActivation.encodeDelimited(activation).finish();
    // Loop and invoke each job with entire microtasks chain.
    // This is done outside of the isolate because we can't wait for microtasks from inside the isolate.
    for (const idx in activation.jobs) {
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

  public async registerImplementation(path: string) {
    const mod = await this.loader.loadModule(path);
    this.loader.overrideModule('main', mod);
    const registerWorkflow = await this.loader.loadModule(pathResolve(__dirname, '../workflow-lib/lib/register-workflow.js'));
    const run = await registerWorkflow.namespace.get('run');
    await run.apply(undefined, [], {});
  }
}
