import { resolve as pathResolve } from 'path';
import ivm from 'isolated-vm';
import dedent from 'dedent';
import { HistoryEvent } from '../native';
import { Loader } from './loader';
import { Scheduler } from './scheduler';

export enum ApplyMode {
  ASYNC = 'apply',
  SYNC = 'applySync',
  IGNORED = 'applyIgnored',
  SYNC_PROMISE = 'applySyncPromise',
}

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;

interface WorkflowModule {
  trigger: ivm.Reference<Function>;
  getAndResetCommands: ivm.Reference<Function>;
}

export class Workflow {
  private readonly activities: Map<string, Map<string, Function>> = new Map();

  private constructor(
    public readonly id: string,
    readonly isolate: ivm.Isolate,
    readonly context: ivm.Context,
    public readonly scheduler: Scheduler,
    readonly loader: Loader,
    readonly workflowModule: WorkflowModule,
  ) {
  }

  public static async create(id: string, scheduler: Scheduler = new Scheduler()) {
    const isolate = new ivm.Isolate();
    const context = await isolate.createContext();
    const loader = new Loader(isolate, context);
    const workflowInternals = await loader.loadModule(pathResolve(__dirname, '../workflow-lib/lib/internals.js'));
    const workflowModule = await loader.loadModule(pathResolve(__dirname, '../workflow-lib/lib/workflow.js'));
    const trigger = await workflowInternals.namespace.get('trigger');
    const getAndResetCommands = await workflowInternals.namespace.get('getAndResetCommands');
    const initWorkflow = await workflowInternals.namespace.get('initWorkflow');
    loader.overrideModule('@temporal-sdk/workflow', workflowModule);

    await initWorkflow.apply(undefined, [id], { arguments: { copy: true } });

    return new Workflow(id, isolate, context, scheduler, loader, { trigger, getAndResetCommands });
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

  public async trigger(events: HistoryEvent[]) {
    await this.workflowModule.trigger.apply(undefined, [events], { arguments: { copy: true }, result: { copy: true } });
    // Microtasks will already have run at this point
    return this.workflowModule.getAndResetCommands.apply(undefined, [], { result: { copy: true } });
  }

  public async runMain(path: string) {
    const mod = await this.loader.loadModule(path);
    this.loader.overrideModule('main', mod);
    const runner = await this.loader.loadModule(pathResolve(__dirname, '../workflow-lib/lib/eval.js'));
    const run = await runner.namespace.get('run');

    // Run main, result will be stored in an output command
    await run.apply(undefined, [], {});
    // Microtasks will already have run at this point
    return this.workflowModule.getAndResetCommands.apply(undefined, [], { result: { copy: true } });
  }

  public async run(path: string) {
    const mod = await this.loader.loadModule(path);
    const main = await mod.namespace.get('main');
    main.applySync(undefined, [], { result: { promise: true, copy: true } });
    await this.scheduler.run();
  }
}
