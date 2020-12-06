import fs from 'fs/promises';
import ivm from 'isolated-vm';

export enum ApplyMode {
  ASYNC = 'apply',
  SYNC = 'applySync',
  IGNORED = 'applyIgnored',
  SYNC_PROMISE = 'applySyncPromise',
}

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;

export interface PromiseCreateEvent {
  type: 'PromiseCreateEvent',
}

export interface PromiseResolveEvent {
  type: 'PromiseResolveEvent',
  promiseId: number,
  value: unknown,
}

export interface PromiseRegisterEvent {
  type: 'PromiseRegisterEvent',
  promiseId: number,
  callback: Fn<[unknown], unknown>,
}

export interface PromiseCompleteEvent {
  type: 'PromiseCompleteEvent',
  promiseId: number,
  value: unknown,
}

type Event = PromiseCompleteEvent | PromiseCreateEvent | PromiseRegisterEvent | PromiseResolveEvent;

type Fn<TArgs extends any[], TRet> = (...args: TArgs) => TRet;

export class InvalidSchedulerState extends Error {
  public readonly name: string = 'InvalidSchedulerState';
}

interface EmptyPromiseState {
  state: 'CREATED',
  callbacks: Array<Fn<[unknown], unknown>>,
}

interface ResolvedPromiseState {
  state: 'RESOLVED',
  callbacks: Array<Fn<[unknown], unknown>>,
  value: unknown,
}

type PromiseState = Readonly<EmptyPromiseState | ResolvedPromiseState>;
// interface PromiseState {
//   callbacks: Array<Fn<[unknown], unknown>>,
//   state: 'CREATED' | 'RESOLVED' | 'REJECTED',
//   value?: unknown,
//   error?: unknown,
// }

interface SchedulerState {
  promises: Map<number, PromiseState>,
}

export class Timeline {
  private history: Event[] = [];
  private state: SchedulerState = { promises: new Map() };

  public handleEvent(event: Event) {
    const eventIndex = this.history.length;
    const state = this.state;
    console.log('handleEvent', event);

    switch (event.type) {
      case 'PromiseCreateEvent': {
        state.promises.set(eventIndex, { state: 'CREATED', callbacks: [] });
        break;
      }
      case 'PromiseRegisterEvent': {
        let promise = state.promises.get(event.promiseId);
        if (promise === undefined) {
          throw new InvalidSchedulerState(`No promise state for Promise ${event.promiseId}`);
        }
        promise.callbacks.push(event.callback);
        break;
      }
      case 'PromiseResolveEvent': {
        let promise = state.promises.get(event.promiseId);
        if (promise === undefined) {
          throw new InvalidSchedulerState(`No promise state for Promise ${event.promiseId}`);
        }
        state.promises.set(event.promiseId, {
          callbacks: promise.callbacks,
          state: 'RESOLVED',
          value: event.value,
        });
        break;
      }
      case 'PromiseCompleteEvent': {
        let promise = state.promises.get(event.promiseId);
        if (promise === undefined) {
          throw new InvalidSchedulerState(`No promise state for Promise ${event.promiseId}`);
        }
        for (const callback of promise.callbacks) {
          // TODO: support chaining
          callback(event.value);
        }
        break;
      }
    }
    this.history.push(event);
    return eventIndex;
  }

  public complete(): Promise<void> {
    // TODO: handle rejection
    return new Promise((resolve) => {
      this.handleEvent({ type: 'PromiseRegisterEvent', promiseId: 0, callback: () => resolve() });
    });
  }

  public async* run() {
    let lastHandledEventId = 0;
    const historyLength = this.history.length;
    for (; lastHandledEventId < historyLength; ++lastHandledEventId) {
      const event = this.history[lastHandledEventId];
      switch (event.type) {
        case 'PromiseResolveEvent':
        case 'PromiseRegisterEvent':
          const promise = this.state.promises.get(event.promiseId)!;
          if (promise.state === 'RESOLVED') {
            await new Promise((resolve) => setImmediate(resolve));
            this.handleEvent({ type: 'PromiseCompleteEvent', promiseId: event.promiseId, value: promise.value });
          }
        case 'PromiseCompleteEvent':
          if (event.promiseId === 0) {
            break;
          }
      }
    }
  }
}

export class Workflow {
  public readonly id: string;

  private constructor(
    readonly isolate: ivm.Isolate,
    readonly context: ivm.Context,
    public readonly timeline: Timeline,
  ) {
    this.id = 'TODO';
  }

  public static async create(timeline: Timeline = new Timeline()) {
    const isolate = new ivm.Isolate();
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set('global', jail.derefInto());
    const workflow = new Workflow(isolate, context, timeline);
    await workflow.injectPromise();
    return workflow;
  }

  private async injectPromise() {
    const timeline = this.timeline;
    function then(promiseId: ivm.Reference<number>, callback: ivm.Reference<Function>) {
      timeline.handleEvent({
        type: 'PromiseRegisterEvent',
        promiseId: promiseId.copySync(),
        callback: (value: unknown) => callback.applySync(undefined, [value], { arguments: { copy: true } }),
      });
    }

    function createPromise(callback: ivm.Reference<Function>) {
      const promiseId = timeline.handleEvent({ type: 'PromiseCreateEvent' });
      callback.applySync(
        undefined, [
          (value: unknown) => timeline.handleEvent({ type: 'PromiseResolveEvent', value, promiseId }),
          // TODO: reject,
        ], {
          arguments: { reference: true },
        });
      return promiseId;
    }

    await this.context.evalClosure(
      `global.Promise = function(executor) {
        this.promiseId = $0.applySync(
          undefined,
          [
            (resolve, reject) => executor(
              (val) => void resolve.applySync(undefined, [val], { arguments: { copy: true } }),
              (err) => void reject.applySync(undefined, [val], { arguments: { copy: true } }),
            )
          ],
          {
            arguments: { reference: true },
            result: { copy: true },
          },
        );
      }
      global.Promise.prototype.then = function promiseThen(callback) {
        $1.applySync(undefined, [this.promiseId, callback], { arguments: { reference: true } });
      }
      `,
      [createPromise, then], { arguments: { reference: true } });
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
    for await (const _ of this.timeline.run()) {}
  }
}
