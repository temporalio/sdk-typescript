import assert from 'assert';
import { TaskResolvedCallback, TaskRejectedCallback, Event } from './events';

export class InvalidSchedulerState extends Error {
  public readonly name: string = 'InvalidSchedulerState';
}

export interface TaskCallbacks {
  resolvedCallbacks: Array<TaskResolvedCallback>,
  rejectedCallbacks: Array<TaskRejectedCallback>,
}

export interface EmptyTaskState extends TaskCallbacks {
  state: 'CREATED',
}

export interface ResolvedTaskState extends TaskCallbacks {
  state: 'RESOLVED',
  valueIsTaskId: boolean,
  value: unknown,
}

export interface RejectedTaskState extends TaskCallbacks {
  state: 'REJECTED',
  error: unknown,
}

type TaskState = Readonly<EmptyTaskState | ResolvedTaskState | RejectedTaskState>;

interface SchedulerState {
  tasks: Map<number, TaskState>,
  isReplay: boolean,
  replayIndex: number,
}

function createTaskCallbacks(): TaskCallbacks {
  return {
    resolvedCallbacks: [],
    rejectedCallbacks: [],
  };
}

function createTask(): EmptyTaskState {
  return {
    state: 'CREATED',
    ...createTaskCallbacks(),
  };
}

function sanitizeEvent(event: any): any {
  const { callback, callbacks, ...sanitizedEvent } = event;
  return sanitizedEvent;
}

export class Scheduler {
  public readonly history: Event[];
  public readonly state: SchedulerState;
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
    if (this.state.isReplay) {
      while (Scheduler.replayFastForwardEvents.has(this.history[++this.state.replayIndex].type)) ; // These won't get requeued, fast-forward
      // console.log('> Enqueue Event', this.state.replayIndex, event);
      const historyEvent = this.history[this.state.replayIndex];
      if (historyEvent.type !== event.type) {
        throw new InvalidSchedulerState(`Expected ${historyEvent.type} got ${event.type} at history index ${this.state.replayIndex}`);
      }
      assert.deepStrictEqual(sanitizeEvent(event), sanitizeEvent(historyEvent));
      this.history[this.state.replayIndex] = event;
      return this.state.replayIndex;
    }
    const eventIndex = this.history.length;
    // console.log('> Enqueue Event', eventIndex, event);
    this.history.push(event);
    return eventIndex;
  }

  public async run() {
    let eventIndex = 0;
    let promiseID = 0;
    const pendingPromises: Map<number, Promise<{ ev?: Event, id: number }>> = new Map();
    const defer = (fn: () => Promise<Event | undefined>) => {
      const promise = fn();
      const id = promiseID++;
      pendingPromises.set(id, promise.then((ev?: Event) => ({ id, ev })));
    };

    while (true) {
      for (; eventIndex < this.history.length; ++eventIndex) {
        const event = this.history[eventIndex];
        // console.log('< Handle event ', eventIndex, event);
        switch (event.type) {
          case 'TaskCreate':
            this.state.tasks.set(eventIndex, createTask());
            break;
          case 'PromiseReject': {
            const task = this.getTaskState(event.taskId);
            this.state.tasks.set(event.taskId, {
              state: 'REJECTED',
              error: event.error,
              ...createTaskCallbacks(),
            });
            if (task.rejectedCallbacks.length > 0) {
              this.enqueueEvent({
                type: 'TaskRejectedTrigger',
                taskId: event.taskId,
                error: event.error,
                callbacks: task.rejectedCallbacks,
              });
            }
            break;
          }
          case 'ActivityResolve':
          case 'TimerResolve':
          case 'PromiseResolve': {
            const task = this.getTaskState(event.taskId);
            if (event.valueIsTaskId) {
              this.enqueueEvent({
                type: 'TaskResolvedRegister',
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
                state: 'RESOLVED',
                valueIsTaskId: false,
                value: event.value,
                ...createTaskCallbacks(),
              });
              if (task.resolvedCallbacks.length > 0) {
                this.enqueueEvent({
                  type: 'TaskResolvedTrigger',
                  taskId: event.taskId,
                  valueIsTaskId: false,
                  value: event.value,
                  callbacks: task.resolvedCallbacks,
                });
              }
            }
            break;
          }
          case 'TaskResolvedRegister': {
            const task = this.getTaskState(event.taskId);
            switch (task.state) {
              case 'RESOLVED':
                this.enqueueEvent({
                  type: 'TaskResolvedTrigger',
                  taskId: event.taskId,
                  value: task.value,
                  valueIsTaskId: task.valueIsTaskId,
                  callbacks: [event.callback],
                });
                break;
              case 'CREATED':
                task.resolvedCallbacks.push(event.callback);
                break;
            }
            break;
          }
          case 'TaskRejectedRegister': {
            const task = this.getTaskState(event.taskId);
            switch (task.state) {
              case 'REJECTED':
                this.enqueueEvent({
                  type: 'TaskRejectedTrigger',
                  taskId: event.taskId,
                  error: task.error,
                  callbacks: [event.callback],
                });
                break;
              case 'CREATED':
                task.rejectedCallbacks.push(event.callback);
                break;
            }
            break;
          }
          case 'TaskRejectedTrigger': {
            for (const callback of event.callbacks) {
              callback(event.error);
            }
            break;
          }
          case 'TaskResolvedTrigger': {
            for (const callback of event.callbacks) {
              callback(event.valueIsTaskId, event.value);
            }
            break;
          }
          case 'ActivityInvoke': {
            const { fn, taskId, args } = event;
            // TODO: implement options
            if (!this.state.isReplay) {
              defer(async () => {
                let value = fn(args);
                if (value instanceof Promise) {
                  value = await value;
                }

                return {
                  type: 'ActivityResolve',
                  taskId,
                  valueIsTaskId: false,
                  value,
                } as const;
              });
            }
            break;
          }
          case 'TimerStart': {
            const taskId = this.enqueueEvent({ type: 'TaskCreate' });
            this.enqueueEvent({ type: 'TaskResolvedRegister', taskId, callback: event.callback });
            if (!this.state.isReplay) {
              defer(async () => {
                await new Promise((resolve) => setTimeout(resolve, event.ms));

                return {
                  type: 'TimerResolve',
                  taskId,
                  value: undefined,
                  valueIsTaskId: false,
                } as const;
              });
            }
            break;
          }
        }
      }
      if (pendingPromises.size === 0) {
        return;
      }
      const { id, ev } = await Promise.race(pendingPromises.values());
      if (ev !== undefined) this.enqueueEvent(ev);
      pendingPromises.delete(id);
    }
  }
}
