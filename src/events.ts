import { ActivityOptions } from './activity';
export type TaskResolvedCallback = (valueIsTaskId: boolean, value: unknown) => unknown;
export type TaskRejectedCallback = (err: unknown) => unknown;

export interface TaskCreateEvent {
  type: 'TaskCreate',
}

export interface PromiseResolveEvent {
  type: 'PromiseResolve',
  taskId: number,
  valueIsTaskId: boolean,
  value: unknown,
}

export interface PromiseRejectEvent {
  type: 'PromiseReject',
  taskId: number,
  error: unknown,
}

export interface TaskResolvedRegisterEvent {
  type: 'TaskResolvedRegister',
  taskId: number,
  callback: TaskResolvedCallback,
}

export interface TaskRejectedRegisterEvent {
  type: 'TaskRejectedRegister',
  taskId: number,
  callback: TaskRejectedCallback,
}

export interface TaskResolvedTriggerEvent {
  type: 'TaskResolvedTrigger',
  taskId: number,
  valueIsTaskId: boolean,
  value: unknown,
  callbacks: Array<TaskResolvedCallback>,
}

export interface TaskRejectedTriggerEvent {
  type: 'TaskRejectedTrigger',
  taskId: number,
  error: unknown,
  callbacks: Array<TaskRejectedCallback>,
}

export interface TimerStartEvent {
  type: 'TimerStart',
  ms: number,
  callback: () => unknown,
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
  fn: (...args: unknown[]) => Promise<unknown>,
  args: unknown[],
}

export interface ActivityResolveEvent {
  type: 'ActivityResolve',
  taskId: number,
  valueIsTaskId: boolean,
  value: unknown,
}

export type Event = 
  TaskResolvedTriggerEvent
  | TaskRejectedTriggerEvent
  | TaskCreateEvent
  | TaskResolvedRegisterEvent
  | TaskRejectedRegisterEvent
  | PromiseResolveEvent
  | PromiseRejectEvent
  | TimerStartEvent
  | TimerResolveEvent
  | ActivityInvokeEvent
  | ActivityResolveEvent
;
