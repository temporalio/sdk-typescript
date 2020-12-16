import { ActivityOptions } from './activity';
export type TaskCompleteCallback = (valueIsTaskId: boolean, value: unknown) => unknown;

export interface TaskCreateEvent {
  type: 'TaskCreate',
}

export interface PromiseResolveEvent {
  type: 'PromiseResolve',
  taskId: number,
  valueIsTaskId: boolean,
  value: unknown,
}

export interface TaskRegisterEvent {
  type: 'TaskRegister',
  taskId: number,
  callback: TaskCompleteCallback,
}

export interface TaskCallbackTriggerEvent {
  type: 'TaskCallbackTrigger',
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
  TaskCallbackTriggerEvent
  | TaskCreateEvent
  | TaskRegisterEvent
  | PromiseResolveEvent
  | TimerStartEvent
  | TimerResolveEvent
  | ActivityInvokeEvent
  | ActivityResolveEvent
;
