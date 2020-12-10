import { dirname, resolve as pathResolve, extname } from 'path';
import assert from 'assert';
import fs from 'fs/promises';
import ivm from 'isolated-vm';
import dedent from 'dedent';
import { ActivityOptions, Fn } from './activity';

export enum ApplyMode {
  ASYNC = 'apply',
  SYNC = 'applySync',
  IGNORED = 'applyIgnored',
  SYNC_PROMISE = 'applySyncPromise',
}

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;

export type TaskCompleteCallback = Fn<[boolean, unknown], unknown>;

export interface PromiseCreateEvent {
  type: 'PromiseCreate',
}

export interface PromiseResolveEvent {
  type: 'PromiseResolve',
  taskId: number,
  valueIsTaskId: boolean,
  value: unknown,
}

export interface PromiseRegisterEvent {
  type: 'PromiseRegister',
  taskId: number,
  callback: TaskCompleteCallback,
}

export interface PromiseCompleteEvent {
  type: 'PromiseComplete',
  taskId: number,
  valueIsTaskId: boolean,
  value: unknown,
  callbacks: Array<TaskCompleteCallback>,
}

export interface TimerStartEvent {
  type: 'TimerStart',
  ms: number,
  callback: Fn<[], unknown>,
}

export interface TimerCancelEvent {
  type: 'TimerCancel',
  timerId: number,
}

export interface TimerResolveEvent {
  type: 'TimerResolve',
  taskId: number,
  valueIsTaskId: boolean,
  value: unknown,
}

export interface ActivityInvokeEvent {
  type: 'ActivityInvoke',
  taskId: number,
  options: ActivityOptions,
  fn: Fn<unknown[], Promise<unknown>>,
  args: unknown[],
}

export interface ActivityResolveEvent {
  type: 'ActivityResolve',
  taskId: number,
  valueIsTaskId: boolean,
  value: unknown,
}

type Event = 
  PromiseCompleteEvent
  | PromiseCreateEvent
  | PromiseRegisterEvent
  | PromiseResolveEvent
  | TimerStartEvent
  | TimerResolveEvent
  | ActivityInvokeEvent
  | ActivityResolveEvent
;

export class InvalidSchedulerState extends Error {
  public readonly name: string = 'InvalidSchedulerState';
}

export interface EmptyTaskState {
  state: 'CREATED',
  callbacks: Array<TaskCompleteCallback>,
}

export interface ResolvedTaskState {
  state: 'RESOLVED',
  callbacks: Array<TaskCompleteCallback>,
  valueIsTaskId: boolean,
  value: unknown,
}

export interface RejectedTaskState {
  state: 'REJECTED',
  callbacks: Array<TaskCompleteCallback>,
  error: unknown,
}

type TaskState = Readonly<EmptyTaskState | ResolvedTaskState | RejectedTaskState>;

interface SchedulerState {
  tasks: Map<number, TaskState>,
  isReplay: boolean,
  replayIndex: number,
}

function sanitizeEvent(event: any): any {
  const { callback, callbacks, ...sanitizedEvent } = event;
  return sanitizedEvent;
}

export class Timeline {
  public readonly history: Event[];
  public readonly state: SchedulerState;
  private onEnqueue: Fn<[], void> | undefined;
  public static replayFastForwardEvents: Set<Event['type']> = new Set(['TimerResolve', 'ActivityResolve']);

  constructor(history: Event[] = []) {
    this.state = { tasks: new Map(), isReplay: history.length > 0, replayIndex: -1 };
    this.history = history;
  }

  protected getTaskState(taskId: number) {
    const task = this.state.tasks.get(taskId);
    if (task === undefined) throw new InvalidSchedulerState(`No task state for task Id: ${taskId}`);
    return task;
  }

  public startReplay() {
    this.state.isReplay = true;
    this.state.replayIndex = -1;
  }

  public enqueueEvent(event: Event) {
    if (this.onEnqueue !== undefined) {
      this.onEnqueue();
    }
    if (this.state.isReplay) {
      while (Timeline.replayFastForwardEvents.has(this.history[++this.state.replayIndex].type)) ; // These won't get requeued, fast-forward
      console.log('> Enqueue Event', this.state.replayIndex, event);
      const historyEvent = this.history[this.state.replayIndex];
      if (historyEvent.type !== event.type) {
        throw new InvalidSchedulerState(`Expected ${historyEvent.type} got ${event.type} at history index ${this.state.replayIndex}`);
      }
      assert.deepStrictEqual(sanitizeEvent(event), sanitizeEvent(historyEvent));
      this.history[this.state.replayIndex] = event;
      return this.state.replayIndex;
    }
    const eventIndex = this.history.length;
    console.log('> Enqueue Event', eventIndex, event);
    this.history.push(event);
    return eventIndex;
  }

  public async run() {
    let eventIndex = 0;
    let pendingPromises: Array<Promise<void>> = [];
    while (true) {
      for (; eventIndex < this.history.length; ++eventIndex) {
        const event = this.history[eventIndex];
        console.log('< Handle event ', eventIndex, event);
        switch (event.type) {
          case 'PromiseCreate':
            this.state.tasks.set(eventIndex, { state: 'CREATED', callbacks: [] });
            break;
          case 'ActivityResolve':
          case 'TimerResolve':
          case 'PromiseResolve': {
            const task = this.getTaskState(event.taskId);
            if (event.valueIsTaskId) {
              this.enqueueEvent({
                type: 'PromiseRegister',
                taskId: event.value as number,
                callback: (valueIsTaskId, value) => {
                  this.enqueueEvent({
                    type: 'PromiseResolve',
                    taskId: event.taskId,
                    valueIsTaskId,
                    value,
                  })
                },
              });
            } else {
              this.state.tasks.set(event.taskId, {
                callbacks: [],
                state: 'RESOLVED',
                valueIsTaskId: false,
                value: event.value,
              });
              await new Promise((resolve) => setImmediate(resolve));
              if (task.callbacks.length > 0) {
                this.enqueueEvent({
                  type: 'PromiseComplete',
                  taskId: event.taskId,
                  valueIsTaskId: false,
                  value: event.value,
                  callbacks: task.callbacks,
                });
              }
            }
            break;
          }
          case 'PromiseRegister': {
            const task = this.getTaskState(event.taskId);
            switch (task.state) {
              case 'RESOLVED':
                await new Promise((resolve) => setImmediate(resolve));
                this.enqueueEvent({
                  type: 'PromiseComplete',
                  taskId: event.taskId,
                  value: task.value,
                  valueIsTaskId: task.valueIsTaskId,
                  callbacks: [event.callback],
                });
                break;
              case 'CREATED':
                task.callbacks.push(event.callback);
                break;
            }
            break;
          }
          case 'ActivityInvoke': {
            const { fn, taskId, args } = event;
            // TODO: implement options
            if (!this.state.isReplay) {
              const promise = (async() => {
                let value = fn(args);
                if (value instanceof Promise) {
                  value = await value;
                }

                this.enqueueEvent({
                  type: 'ActivityResolve',
                  taskId,
                  valueIsTaskId: false,
                  value,
                });
              })();
              pendingPromises.push(promise);
            }
            break;
          }
          case 'TimerStart': {
            const taskId = this.enqueueEvent({ type: 'PromiseCreate' });
            this.enqueueEvent({ type: 'PromiseRegister', taskId, callback: event.callback });
            if (!this.state.isReplay) {
              const promise = (async () => {
                await new Promise((resolve) => setTimeout(resolve, event.ms));
                // TODO: create a separate event for TimerComplete
                this.enqueueEvent({
                  type: 'TimerResolve',
                  taskId,
                  value: undefined,
                  valueIsTaskId: false,
                });
              })();
              pendingPromises.push(promise);
            }
            break;
          }
          case 'PromiseComplete': {
            for (const callback of event.callbacks) {
              callback(event.valueIsTaskId, event.value);
            }
            if (event.taskId === 0) { // Promise created by running main()
              return;
            }
            break;
          }
        }
      }
      if (pendingPromises.length > 0) {
        const enqueuePromise = new Promise<void>((resolve) => {
          this.onEnqueue = () => {
            console.log('onEnqueue');
            resolve();
          }
        });
        await Promise.race([
          enqueuePromise,
          Promise.all(pendingPromises).then(() => { pendingPromises = [] }),
        ]);
        this.onEnqueue = undefined;
      } else if (this.state.tasks.get(0)?.state === "RESOLVED") {
        return;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
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
    const workflow = new Workflow(isolate, context, timeline);

    // Delete any weak reference holding structures because GC is non-deterministic.
    // WeakRef is implemented in V8 8.4 while node 14 embeds V8 8.3, delete it just in case.
    await context.eval(dedent`
      globalThis.activities = {};
      delete globalThis.WeakMap;
      delete globalThis.WeakSet;
      delete globalThis.WeakRef;
    `);
    await workflow.injectPromise();
    await workflow.injectTimers();
    return workflow;
  }

  private async injectTimers() {
    const timeline = this.timeline;
    function createTimer(callback: ivm.Reference<Function>, msRef: ivm.Reference<number>, ...args: ivm.Reference<any>[]) {
      const ms = msRef.copySync(); // Copy sync since the isolate executes setTimeout with EvalMode.SYNC
      return timeline.enqueueEvent({
        type: 'TimerStart',
        ms,
        callback: () => callback.applySync(undefined, args),
      });
    }
    await this.inject('setTimeout', createTimer, ApplyMode.SYNC, { arguments: { reference: true } });
  }

  public async injectActivity(name: string, impl: Fn<any[], any>) {
    const timeline = this.timeline;

    const invoke = (options: ActivityOptions, args: any[]) => {
      const taskId = this.timeline.enqueueEvent({ type: 'PromiseCreate' });
      timeline.enqueueEvent({
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


  private async injectPromise() {
    const timeline = this.timeline;

    function createPromise(callback: ivm.Reference<Function>) {
      const taskId = timeline.enqueueEvent({ type: 'PromiseCreate' });
      callback.applySync(
        undefined, [
          (valueIsTaskId: boolean, value: unknown) => void timeline.enqueueEvent({ type: 'PromiseResolve', valueIsTaskId, value, taskId })
          // TODO: reject,
        ], {
          arguments: { reference: true },
        });
      return taskId;
    }

    function then(taskId: ivm.Reference<number>, callback: ivm.Reference<Function>) {
      const nextTaskId = timeline.enqueueEvent({ type: 'PromiseCreate' });
      timeline.enqueueEvent({
        type: 'PromiseRegister',
        taskId: taskId.copySync(),
        callback: (_, value) => {
          const [valueIsTaskId, nextValue] = callback.applySync(undefined, [value], { arguments: { copy: true, }, result: { copy: true } }) as any; // TODO
          timeline.enqueueEvent({
            type: 'PromiseResolve',
            taskId: nextTaskId,
            valueIsTaskId,
            value: nextValue,
          });
        },
      });
      return nextTaskId;
    }

    await this.context.evalClosure(
      `
      globalThis.Promise = function(executor) {
        this.taskId = $0.applySync(
          undefined,
          [
            (resolve, reject) => executor(
              (value) => {
                const isPromise = value instanceof Promise;
                const resolvedValue = isPromise ? value.taskId : value;
                resolve.applySync(undefined, [isPromise, resolvedValue], { arguments: { copy: true } });
              },
              (err) => void reject.applySync(undefined, [err], { arguments: { copy: true } }),
            )
          ],
          {
            arguments: { reference: true },
            result: { copy: true },
          },
        );
      }
      globalThis.Promise.prototype.then = function promiseThen(callback) {
        const promise = Object.create(null);
        Object.setPrototypeOf(promise, Promise.prototype);
        const wrapper = function (value) {
          const ret = callback(value);
          const isPromise = ret instanceof Promise;
          const resolvedValue = isPromise ? ret.taskId : ret;
          return [isPromise, resolvedValue];
        }
        promise.taskId = $1.applySync(undefined, [this.taskId, wrapper], { arguments: { reference: true } });
        return promise;
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

    await this.context.evalClosure(dedent`
    globalThis.${path} = function(...args) {
      return $0.${applyMode}(
        undefined,
        args,
        ${JSON.stringify(transferOptions)},
      );
    }`, [handler], { arguments: { reference: true } });
  }

  async moduleResolveCallback(specifier: string, referrer: ivm.Module) {
    const referrerFilename = (referrer as any).filename; // Hacky way of resolving relative imports
    const root = dirname(referrerFilename);
    const ext = extname(specifier);
    if (ext === '') {
      specifier += '.js';
    } else if (ext !== 'js') {
      throw new Error('Only .js files can be imported');
    }

    // TODO: check if specifier contains a path (e.g. ./)
    const filename = pathResolve(root, specifier);
    console.log('Instantiate', filename, (referrer as any).filename);
    // TODO: assert modulePath in allowed root
    const code = await fs.readFile(filename, 'utf8');
    const compiled = await this.isolate.compileModule(code, { filename });
    (compiled as any).filename = filename; // Hacky way of resolving relative imports
    return compiled;
  }

  public async run(path: string) {
    const code = await fs.readFile(path, 'utf8');
    const mod = await this.isolate.compileModule(code, { filename: path });
    (mod as any).filename = path; // Hacky way of resolving relative imports
    await mod.instantiate(this.context, this.moduleResolveCallback.bind(this));
    await mod.evaluate();
    const main = await mod.namespace.get('main');
    await main.apply(undefined, [], { result: { promise: true, copy: true } });
    await this.timeline.run();
  }
}
