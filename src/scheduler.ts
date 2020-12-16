import assert from 'assert';
import { TaskCompleteCallback, Event } from './events';

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
    const pendingPromises: Map<number, Promise<{ ev: Event, id: number }>> = new Map();

    while (true) {
      for (; eventIndex < this.history.length; ++eventIndex) {
        const event = this.history[eventIndex];
        // console.log('< Handle event ', eventIndex, event);
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

                return {
                  type: 'ActivityResolve',
                  taskId,
                  valueIsTaskId: false,
                  value,
                } as const;
              })();
              const id = promiseID++;
              pendingPromises.set(id, promise.then((ev: Event) => ({ id, ev })));
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
                return {
                  type: 'TimerResolve',
                  taskId,
                  value: undefined,
                  valueIsTaskId: false,
                } as const;
              })();
              const id = promiseID++;
              pendingPromises.set(id, promise.then((ev: Event) => ({ id, ev })));
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
      if (pendingPromises.size > 0) {
        const { id, ev } = await Promise.race(pendingPromises.values());
        this.enqueueEvent(ev);
        pendingPromises.delete(id);
      } else if (this.state.tasks.get(0)?.state === "RESOLVED") {
        return;
      }
    }
  }
}
