import ivm from 'isolated-vm';
import dedent from 'dedent';
import { Loader } from './loader';
import { ActivityOptions, Fn } from './activity';
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

  public async injectActivity(name: string, impl: Fn<any[], any>) {
    const scheduler = this.scheduler;

    function invoke(
      options: ivm.Reference<ActivityOptions>, args: ivm.Reference<any[]>, resolve: ivm.Reference<Function>, reject: ivm.Reference<Function>
    ) {
      scheduler.enqueueEvent({
        type: 'ActivityInvoke',
        options: options.copySync(),
        fn: impl,
        args: args.copySync(),
        resolve: (val) => resolve.apply(undefined, [val]),
        reject: (val) => reject.apply(undefined, [val]),
      });
    }

    await this.context.evalClosure(dedent`
      function invoke(options, args) {
        return new Promise((resolve, reject) => {
          $0.applySync(undefined, [{}, args, resolve, reject], { arguments: { reference: true } });
        });
      }

      globalThis.activities.${name} = function(...args) {
        return invoke({}, args);
      }
      globalThis.activities.${name}.withOptions = function(options) {
        return { invoke: (...args) => invoke(options, args) };
      }
      `,
      [invoke], { arguments: { reference: true } });
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
