import fs from 'fs/promises';
import ivm from 'isolated-vm';

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

type Event = 
  PromiseCompleteEvent
  | PromiseCreateEvent
  | PromiseRegisterEvent
  | PromiseResolveEvent
  | TimerStartEvent
;

type Fn<TArgs extends any[], TRet> = (...args: TArgs) => TRet;

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
}

export class Timeline {
  private history: Event[] = [];
  private state: SchedulerState = { tasks: new Map() };

  protected getTaskState(taskId: number) {
    const task = this.state.tasks.get(taskId);
    if (task === undefined) throw new InvalidSchedulerState(`No task state for task Id: ${taskId}`);
    return task;
  }

  public enqueueEvent(event: Event) {
    const eventIndex = this.history.length;
    // console.log('> Enqueue Event', eventIndex, event);
    this.history.push(event);
    return eventIndex;
  }

  public async run() {
    let eventIndex = 0;
    for (; eventIndex < this.history.length; ++eventIndex) {
      const event = this.history[eventIndex];
      console.log('< Handle event ', eventIndex, event);
      switch (event.type) {
        case 'PromiseCreate':
          this.state.tasks.set(eventIndex, { state: 'CREATED', callbacks: [] });
          break;
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
        case 'TimerStart':
          this.state.tasks.set(eventIndex, { state: 'CREATED', callbacks: [] });
          await new Promise((resolve) => setTimeout(resolve, event.ms));
          // TODO: create a separate event for TimerComplete
          this.enqueueEvent({
            type: 'PromiseComplete',
            taskId: eventIndex,
            value: undefined,
            valueIsTaskId: false,
            callbacks: [event.callback],
          });
          break;
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
    await context.evalClosure('global.exports = {}'); // Needed for exporting main
    await workflow.injectPromise();
    await workflow.injectTimers();
    return workflow;
  }

  private async injectTimers() {
    const timeline = this.timeline;
    function createTimer(callback: ivm.Reference<Function>, msRef: ivm.Reference<number>, ...args: ivm.Reference<any>[]) {
      const ms = msRef.copySync(); // Copy sync since the isolate executes setTimeout with EvalMode.SYNC
      timeline.enqueueEvent({
        type: 'TimerStart',
        ms,
        callback: () => callback.applySync(undefined, args),
      });
    }
    await this.inject('setTimeout', createTimer, ApplyMode.SYNC, { arguments: { reference: true } });
  }

  private async injectPromise() {
    const timeline = this.timeline;

    function createPromise(callback: ivm.Reference<Function>) {
      const taskId = timeline.enqueueEvent({ type: 'PromiseCreate' });
      callback.applySync(
        undefined, [
          (valueIsTaskId: boolean, value: unknown) => timeline.enqueueEvent({ type: 'PromiseResolve', valueIsTaskId, value, taskId }),
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
      `global.Promise = function(executor) {
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
      global.Promise.prototype.then = function promiseThen(callback) {
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
    await this.timeline.run();
  }
}
