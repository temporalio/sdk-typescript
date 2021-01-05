import { ActivityOptions } from './activity';

export type TaskResolvedCallback = (value: unknown) => Promise<unknown>;
export type TaskRejectedCallback = (err: unknown) => Promise<unknown>;

export interface TaskCreateEvent {
  type: 'TaskCreate',
  onResolved: TaskResolvedCallback,
  onRejected?: TaskRejectedCallback,
}

export interface TaskResolveEvent {
  type: 'TaskResolve',
  taskId: number,
  value: unknown,
}

export interface TaskRejectEvent {
  type: 'TaskReject',
  taskId: number,
  error: unknown,
}

export interface TimerStartEvent {
  type: 'TimerStart',
  ms: number,
  callback: () => Promise<unknown>,
}

export interface ActivityInvokeEvent {
  type: 'ActivityInvoke',
  options: ActivityOptions,
  fn: (...args: unknown[]) => Promise<unknown>,
  resolve: (value: unknown) => Promise<unknown>,
  reject: (value: unknown) => Promise<unknown>,
  args: unknown[],
}

export type Event = 
  TaskResolveEvent
  | TaskRejectEvent
  | TaskCreateEvent
  | TimerStartEvent
  | ActivityInvokeEvent
;
