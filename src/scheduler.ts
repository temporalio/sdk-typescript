import assert from 'assert';
import { TaskResolvedCallback, TaskRejectedCallback, Event } from './events';

export class InvalidSchedulerState extends Error {
  public readonly name: string = 'InvalidSchedulerState';
}

export interface Task {
  onResolved: TaskResolvedCallback,
  onRejected?: TaskRejectedCallback,
}

interface SchedulerState {
  tasks: Map<number, Task>,
  isReplay: boolean,
  replayIndex: number,
}

function sanitizeEvent(event: any): any {
  const { resolve, reject, callback, onResolved, onRejected, ...sanitizedEvent } = event;
  return sanitizedEvent;
}

export class Scheduler {
  public readonly history: Event[];
  public readonly state: SchedulerState;
  public static replayFastForwardEvents: Set<Event['type']> = new Set(['TaskResolve', 'TaskReject']);

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

  public enqueueEvent(event: Event): number {
    if (this.state.isReplay) {
      // fast-forward until we get to the next index for enqueuing
      do {
        ++this.state.replayIndex;
      } while (Scheduler.replayFastForwardEvents.has(this.history[this.state.replayIndex].type));
      const eventIndex = this.state.replayIndex;
      // console.log('> Enqueue Event', idx, event);
      const historyEvent = this.history[eventIndex];
      if (historyEvent.type !== event.type) {
        throw new InvalidSchedulerState(`Expected ${historyEvent.type} got ${event.type} at history index ${eventIndex}`);
      }
      assert.deepStrictEqual(sanitizeEvent(event), sanitizeEvent(historyEvent));
      this.history[eventIndex] = event;
      return eventIndex;
    } else {
      const eventIndex = this.history.length;
      // console.log('> Enqueue Event', eventIndex, event);
      this.history.push(event);
      return eventIndex;
    }
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
            const { onResolved, onRejected } = event;
            this.state.tasks.set(eventIndex, { onResolved, onRejected });
            break;
          case 'TaskResolve': {
            const task = this.getTaskState(event.taskId);
            await task.onResolved(event.value);
            break;
          }
          case 'TaskReject': {
            const task = this.getTaskState(event.taskId);
            if (task.onRejected) {
              await task.onRejected(event.error);
            } // TODO: else throw?
            break;
          }
          case 'ActivityInvoke': {
            const { fn, args, resolve, reject } = event;
            const taskId = this.enqueueEvent({ type: 'TaskCreate', onResolved: resolve, onRejected: reject });
            // TODO: implement options
            if (!this.state.isReplay) {
              defer(async () => {
                try {
                  let value = fn(args);
                  if (value instanceof Promise) {
                    value = await value;
                  }

                  return {
                    type: 'TaskResolve',
                    taskId,
                    value,
                  } as const;
                } catch (error) {
                  return {
                    type: 'TaskReject',
                    taskId,
                    error,
                  } as const;
                }
              });
            }
            break;
          }
          case 'TimerStart': {
            const taskId = this.enqueueEvent({ type: 'TaskCreate', onResolved: event.callback });
            if (!this.state.isReplay) {
              defer(async () => {
                await new Promise((resolve) => setTimeout(resolve, event.ms));

                return {
                  type: 'TaskResolve',
                  taskId,
                  value: undefined,
                };
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
