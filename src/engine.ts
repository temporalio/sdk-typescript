import ivm from 'isolated-vm';
import dedent from 'dedent';
import { Loader } from './loader';
import { ActivityOptions, Fn } from './activity';
import { Scheduler } from './scheduler';
import { injectPromise } from './workflow/promise';

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
    await injectPromise(context, scheduler);
    await workflow.injectTimers();
    return workflow;
  }

  private async injectTimers() {
    const scheduler = this.scheduler;
    function createTimer(callback: ivm.Reference<Function>, msRef: ivm.Reference<number>, ...args: ivm.Reference<any>[]) {
      const ms = msRef.copySync(); // Copy sync since the isolate executes setTimeout with EvalMode.SYNC
      return scheduler.enqueueEvent({
        type: 'TimerStart',
        ms,
        callback: () => callback.applySync(undefined, args),
      });
    }
    await this.inject('setTimeout', createTimer, ApplyMode.SYNC, { arguments: { reference: true } });
  }

  public async injectActivity(name: string, impl: Fn<any[], any>) {
    const scheduler = this.scheduler;

    const invoke = (options: ActivityOptions, args: any[]) => {
      const taskId = this.scheduler.enqueueEvent({ type: 'TaskCreate' });
      scheduler.enqueueEvent({
        type: 'ActivityInvoke',
        taskId,
        options,
        fn: impl,
        args,
      });
      return taskId;
    }

    await this.context.evalClosure(dedent`
      function invoke(options, args) {
        const promise = Object.create(null);
        Object.setPrototypeOf(promise, Promise.prototype);
        promise.taskId = $0.applySync(undefined, [{}, args], { arguments: { copy: true, }, result: { copy: true } });
        return promise;
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
    await main.apply(undefined, [], { result: { promise: true, copy: true } });
    await this.scheduler.run();
  }
}
