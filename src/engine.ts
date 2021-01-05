import ivm from 'isolated-vm';
import dedent from 'dedent';
import { Loader } from './loader';
import { ActivityOptions } from './activity';
import { Scheduler } from './scheduler';

export enum ApplyMode {
  ASYNC = 'apply',
  SYNC = 'applySync',
  IGNORED = 'applyIgnored',
  SYNC_PROMISE = 'applySyncPromise',
}

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;

export class Workflow {
  public readonly id: string;
  private readonly loader: Loader;
  private readonly activities: Map<string, Map<string, Function>> = new Map();

  private constructor(
    readonly isolate: ivm.Isolate,
    readonly context: ivm.Context,
    public readonly scheduler: Scheduler,
  ) {
    this.id = 'TODO';
    this.loader = new Loader(isolate, context);
  }

  public static async create(scheduler: Scheduler = new Scheduler()) {
    const isolate = new ivm.Isolate();
    const context = await isolate.createContext();
    const workflow = new Workflow(isolate, context, scheduler);

    // Delete any weak reference holding structures because GC is non-deterministic.
    // WeakRef is implemented in V8 8.4 which is embedded in node >=14.6.0, delete it just in case.
    await context.eval(dedent`
      globalThis.activities = {};
      delete globalThis.WeakMap;
      delete globalThis.WeakSet;
      delete globalThis.WeakRef;
    `);
    await workflow.injectTimers();
    await workflow.injectActivityStub();
    await workflow.registerWorkflowModule();
    return workflow;
  }

  private async injectTimers() {
    const scheduler = this.scheduler;
    function createTimer(callback: ivm.Reference<Function>, msRef: ivm.Reference<number>, ...args: ivm.Reference<any>[]) {
      const ms = msRef.copySync();
      return scheduler.enqueueEvent({
        type: 'TimerStart',
        ms,
        callback: () => callback.apply(undefined, args),
      });
    }
    await this.inject('setTimeout', createTimer, ApplyMode.SYNC, { arguments: { reference: true } });
  }

  public async injectActivityStub() {
    const scheduler = this.scheduler;
    const activities = this.activities;

    function invoke(
      module: ivm.Reference<string>, name: ivm.Reference<string>, args: ivm.Reference<any[]>, options: ivm.Reference<ActivityOptions>, resolve: ivm.Reference<Function>, reject: ivm.Reference<Function>
    ) {
      const fnName = name.copySync();
      const moduleName = module.copySync();
      const moduleActivities = activities.get(moduleName);
      if (moduleActivities === undefined) {
        throw new Error(`No activities registered for module: ${moduleName}`);
      }
      const impl = moduleActivities.get(fnName);
      if (impl === undefined) {
        throw new Error(`No activities named ${fnName} in module: ${moduleName}`);
      }
      scheduler.enqueueEvent({
        type: 'ActivityInvoke',
        options: options.copySync(),
        fn: impl as any, // TODO
        args: args.copySync(),
        resolve: (val) => resolve.apply(undefined, [val]),
        reject: (val) => reject.apply(undefined, [val]),
      });
    }

    await this.context.evalClosure(dedent`
      globalThis.invokeActivity = function(module, name, args, options) {
        return new Promise((resolve, reject) => {
          $0.applySync(undefined, [module, name, args, options, resolve, reject], { arguments: { reference: true } });
        });
      }
      `,
      [invoke], { arguments: { reference: true } });
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

  public async registerWorkflowModule() {
    const specifier = '@temporal-sdk/workflow';
    const code = dedent`
      export const Context = {
        configure(fn, options) {
          return {
            [fn.name](...args) {
              return invokeActivity(fn.module, fn.name, args, { ...fn.options, ...options });
            }
          }[fn.name];
        },
      }
    `;
    const compiled = await this.isolate.compileModule(code, { filename: specifier });
    await compiled.instantiate(this.context, async () => { throw new Error('Invalid') });
    await compiled.evaluate();
    this.loader.overrideModule(specifier, compiled);
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

  public async run(path: string) {
    const mod = await this.loader.loadModule(path);
    const main = await mod.namespace.get('main');

    // TODO: make this async, for some reason the promise never resolves and the process exits
    main.applySync(undefined, [], { result: { promise: true, copy: true } });
    await this.scheduler.run();
  }
}
