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
  type: 'PromiseCreate',
}

export interface PromiseResolveEvent {
  type: 'PromiseResolve',
  taskId: number,
  value: unknown,
}

export interface PromiseRegisterEvent {
  type: 'PromiseRegister',
  taskId: number,
  callback: Fn<[unknown], unknown>,
}

export interface PromiseCompleteEvent {
  type: 'PromiseComplete',
  taskId: number,
  value: unknown,
  callbacks: Array<Fn<[unknown], unknown>>,
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

interface EmptyTaskState {
  state: 'CREATED',
  callbacks: Array<Fn<[unknown], unknown>>,
}

interface ResolvedTaskState {
  state: 'RESOLVED',
  callbacks: Array<Fn<[unknown], unknown>>,
  value: unknown,
}

type TaskState = Readonly<EmptyTaskState | ResolvedTaskState>;
// interface PromiseState {
//   callbacks: Array<Fn<[unknown], unknown>>,
//   state: 'CREATED' | 'RESOLVED' | 'REJECTED',
//   value?: unknown,
//   error?: unknown,
// }

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
    console.log('> Enqueue Event', eventIndex, event);
    this.history.push(event);
    return eventIndex;
  }

  protected handlePromiseResolve(event: PromiseResolveEvent) {
    const task = this.getTaskState(event.taskId);
    this.state.tasks.set(event.taskId, {
      callbacks: [],
      state: 'RESOLVED',
      value: event.value,
    });
    return task.callbacks;
    // if (typeof event.value === 'object' && event.value !== null && 'taskId' in event.value) {
    //   this.enqueueEvent({
    //     type: 'PromiseRegister',
    //     taskId: (event.value as any).taskId,
    //     callback: (value) => this.enqueueEvent({
    //       type: 'PromiseResolve',
    //       taskId: event.taskId,
    //       value,
    //     }),
    //   });
    // } else {
    //   this.state.tasks.set(event.taskId, {
    //     callbacks: task.callbacks,
    //     state: 'RESOLVED',
    //     value: event.value,
    //   });
    // }
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
          this.state.tasks.set(event.taskId, {
            callbacks: [],
            state: 'RESOLVED',
            value: event.value,
          });
          await new Promise((resolve) => setImmediate(resolve));
          if (task.callbacks.length > 0) {
            this.enqueueEvent({ type: 'PromiseComplete', taskId: event.taskId, value: event.value, callbacks: task.callbacks });
          }
          break;
        }
        case 'PromiseRegister': {
          const task = this.getTaskState(event.taskId);
          switch (task.state) {
            case 'RESOLVED':
              await new Promise((resolve) => setImmediate(resolve));
              this.enqueueEvent({ type: 'PromiseComplete', taskId: event.taskId, value: task.value, callbacks: [event.callback] });
              break;
            case 'CREATED':
              task.callbacks.push(event.callback);
              break;
          }
          break;
        }
        case 'TimerStart':
          this.state.tasks.set(eventIndex, { state: 'CREATED', callbacks: [event.callback] });
          await new Promise((resolve) => setTimeout(resolve, event.ms));
          console.log('firing timer');
          // this.enqueueEvent({ type: 'PromiseComplete', taskId: eventIndex, value: undefined });
          break;
        case 'PromiseComplete': {
          for (const callback of event.callbacks) {
            // TODO: support chaining
            callback(event.value);
          }
          if (event.taskId === 0) {
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
    function then(taskId: ivm.Reference<number>, callback: ivm.Reference<Function>) {
      timeline.enqueueEvent({
        type: 'PromiseRegister',
        taskId: taskId.copySync(),
        callback: (value: unknown) => callback.applySync(undefined, [value], { arguments: { copy: true } }),
      });
    }

    function createPromise(callback: ivm.Reference<Function>) {
      const taskId = timeline.enqueueEvent({ type: 'PromiseCreate' });
      callback.applySync(
        undefined, [
          (value: unknown) => timeline.enqueueEvent({ type: 'PromiseResolve', value, taskId }),
          // TODO: reject,
        ], {
          arguments: { reference: true },
        });
      return taskId;
    }

    await this.context.evalClosure(
      `global.Promise = function(executor) {
        this.taskId = $0.applySync(
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
        $1.applySync(undefined, [this.taskId, callback], { arguments: { reference: true } });
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
