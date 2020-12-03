import fs from 'fs/promises';
import ivm from 'isolated-vm';

export enum ApplyMode {
  ASYNC = 'apply',
  SYNC = 'applySync',
  IGNORED = 'applyIgnored',
  SYNC_PROMISE = 'applySyncPromise',
}

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;

interface Event<T> {
  name: string,
  // args: unknown[],
  result: T,
}

type Fn<TArgs extends any[], TRet> = (...args: TArgs) => TRet;

export class Timeline {
  private cursor: number = 0;
  private history: Array<Event<unknown>> = [];

  private readonly timeoutIdsToTimeouts: Map<number, NodeJS.Timer> = new Map();
  private lastTimeoutId: number = 0;
  private numPendingEvents: number = 0; // main() promise is never resolved
  // private numPendingEvents: number = -1; // main() promise is never resolved

  public startActivity<T>(name: string, action: () => T, pendingModifier: number = 0): T {
    this.numPendingEvents += pendingModifier;
    // TODO: receive args here
    console.log('> Started activity', name);
    let entry: Event<T>;
    if (this.history.length > this.cursor) {
      console.log('Event from timeline');
      entry = this.history[this.cursor] as Event<T>;
      // TODO: is this legal? What to do?
      if (entry.name !== name) {
        throw new Error(`Invalid entry in timeline, got ${entry.name} requested ${name}`);
      }
    } else {
      console.log('Event execution');
      entry = {
        name,
        result: action(),
      };
      this.history.push(entry);
    }
    this.cursor++;

    return entry.result;
  }

  public stats() {
    // TODO
    // for (const entry of this.history) {
    //   entry.name
    // }
  }

  public hasUnprocessedEvents() {
    return this.numPendingEvents > 0;
  }

  public resetCursor() {
    this.cursor = 0;
  }

  public generateActivity<TArgs extends any[], TRet>(name: string, action: Fn<TArgs, TRet>, pendingModifier: number = 0): Fn<TArgs, TRet> {
    return (...args: TArgs) => this.startActivity(name, () => action(...args), pendingModifier);
  }

  public generatePromiseResolve() {
    // TODO: actually resolve the promise
    return (arg: unknown) => this.startActivity('Promise.resolve create', () => {
      return new Promise((resolve) => this.startActivity('Promise.resolve.trigger', () => resolve(arg)));
    });
  }

  public generatePromise() {
    return (
      callback: ivm.Reference<Function>,
    ) => {
      // TODO: store this promise
      return new Promise((resolve, reject) => {
        // TODO: await
        callback.applySync(
          undefined, [
            resolve,
            reject,
            // this.generateActivity('Promise.resolve', resolve, 1),
            // this.generateActivity('Promise.reject', reject, 1)
          ], {
          arguments: { reference: true },
        });
      });
    };
  }

  public generateTimer() {
    const activity = this.generateActivity('timer set', (
      callback: ivm.Reference<Function>,
      msRef: ivm.Reference<number>,
      ...args: ivm.Reference<any>[]
    ) => {
      const ms = msRef.copySync(); // Copy sync since the isolate executes setTimeout with EvalMode.SYNC
      const timeout = setTimeout(async () => {
        await this.startActivity('trigger timer', () => callback.apply(undefined, args.map((arg) => arg.derefInto()), { arguments: { copy: true } }), -1);
      }, ms);
      const timeoutId = ++this.lastTimeoutId;
      this.timeoutIdsToTimeouts.set(timeoutId, timeout);
      return timeoutId;
    }, 1);
    return (
      callback: ivm.Reference<Function>,
      msRef: ivm.Reference<number>,
      ...args: ivm.Reference<any>[]
    ) => {
      const result = activity(callback, msRef, ...args);
      if (this.history.length > this.cursor) {
        console.log('timer from history');
        // TODO: check if cancelled
        // callback.applySync(undefined, args.map((arg) => arg.derefInto()), { arguments: { copy: true } });
      }
      return result;
    }
    // return this.generateActivity('timer', async (
    //   callback: ivm.Reference<Function>,
    //   msRef: ivm.Reference<number>,
    //   ...args: ivm.Reference<any>[]
    // ) => {
    //   const ms = msRef.copySync(); // Copy sync since the isolate executes setTimeout with EvalMode.SYNC
    //   await new Promise((resolve) => setTimeout(resolve, 200));
    //   const timeout = setTimeout(async () => {
    //     await callback.apply(undefined, args.map((arg) => arg.derefInto()), { arguments: { copy: true } });
    //   }, ms);
    //   const timeoutId = ++this.lastTimeoutId;
    //   this.timeoutIdsToTimeouts.set(timeoutId, timeout);
    //   return timeoutId;
    // });
  }
}

export class Workflow {
  public readonly id: string;

  private constructor(
    readonly isolate: ivm.Isolate,
    readonly context: ivm.Context,
    public readonly timeline: Timeline,
  ) {
    const jail = context.global;
    jail.setSync('global', jail.derefInto());
    this.id = 'TODO';
  }

  public static async create(timeline: Timeline = new Timeline()) {
    const isolate = new ivm.Isolate();
    const context = await isolate.createContext();
    const workflow = new Workflow(isolate, context, timeline);
    await workflow.injectPromise();
    return workflow;
  }

  private async injectPromise() {
    const outerThis = this;
    function then(this: Promise<unknown>, callback: ivm.Reference<Function>) {
      Promise.prototype.then.apply(this, [
        (value) => callback.applySync(undefined, [value], { arguments: { copy: true } })
        // (value) => outerThis.timeline.startActivity(
        //   'Promise.then',
        //   () => callback.applySync(undefined, [value], { arguments: { copy: true } }),
        //   -1,
        // )
      ]);
    }
    await this.context.evalClosure(
      `global.Promise = function(executor) {
        this.impl = $0.applySync(
          undefined,
          [
            (resolve, reject) => executor(
              (val) => void resolve.applySync(undefined, [val], { arguments: { copy: true } }),
              (err) => void reject.applySync(undefined, [val], { arguments: { copy: true } }),
            )
          ],
          {
            arguments: { reference: true },
            result: { reference: true },
          },
        );
      }
      global.Promise.prototype.then = function promiseThen(callback) {
        $1.applySync(this.impl.derefInto(), [callback], { arguments: { reference: true } });
      }
      `,
      [this.timeline.generatePromise(), then], { arguments: { reference: true } });
      // [this.timeline.generatePromise(), Promise.prototype.then], { arguments: { reference: true } });
    // await workflow.inject('Promise.resolve', workflow.timeline.generatePromiseResolve(), ApplyMode.SYNC, {
    //   arguments: { reference: true },
    //   result: { promise: true },
    // });
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

    await this.context.evalClosure(`global.${path} = function(...args) {
      return $0.${applyMode}(
        undefined,
        args,
        ${JSON.stringify(transferOptions)},
      );
    }`, [handler], { arguments: { reference: true } });
  }

  public async run(path: string) {
    const code = await fs.readFile(path, 'utf8');
    const script = await this.isolate.compileScript(code);
    await script.run(this.context);
    const main = await this.context.global.get('main');
    await main.apply(undefined, [], { result: { promise: true, copy: true } });
    while (this.timeline.hasUnprocessedEvents()) {
      console.log('unprocessed events');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
