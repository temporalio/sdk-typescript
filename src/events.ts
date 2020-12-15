import { ActivityOptions } from './activity';
export type TaskCompleteCallback = (isPromise: boolean, value: unknown) => unknown;

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
  PromiseCompleteEvent
  | PromiseCreateEvent
  | PromiseRegisterEvent
  | PromiseResolveEvent
  | TimerStartEvent
  | TimerResolveEvent
  | ActivityInvokeEvent
  | ActivityResolveEvent
;
