/// Internals manipulate the Global object, track callbacks, accumulate commands, and provide an interface for interacting with sdk-core.
import { ActivityOptions } from './types';
import { alea } from './alea';

export interface StartTimerCommand {
  type: 'StartTimer';
  seq: number;
  ms: number;
}

export interface CancelTimerCommand {
  type: 'CancelTimer';
  seq: number;
  timerSeq: number;
}

export interface ScheduleActivityCommand {
  type: 'ScheduleActivity';
  seq: number;
  module: string;
  name: string;
  arguments: any[];
  options: ActivityOptions;
}

type Result<R, E> = { ok: R } | { error: E };

export interface CompleteWorkflowCommand {
  type: 'CompleteWorkflow';
  seq: number;
  result: Result<any, any>;
}

export type Command = StartTimerCommand | CancelTimerCommand | ScheduleActivityCommand | CompleteWorkflowCommand;

/**
 * Track command sequences and callbacks, accumulate commands
 */
export const state = {
  callbacks: new Map<number, [Function, Function]>(),
  commands: new Array<Command>(),
  nextSeq: 0,
  /**
   * This is set every time the workflow executes a task
   */
  now: 0,
};

export type Task = any; // TODO

export function trigger(task: Task) {
  state.now = task.timestamp;
  const callbacks = state.callbacks.get(task.taskSeq);
  if (callbacks === undefined) {
    throw new Error(`No callback for taskSeq ${task.taskSeq}`);
  }
  const [callback] = callbacks;
  callback();
}

// TODO: improve this definition
export interface Workflow {
  main(...args: any[]): Promise<any>;
}

export function runWorkflow({ main }: Workflow, timestamp: number) {
  state.now = timestamp;
  main()
    .then((result: any) => {
      const seq = state.nextSeq++;
      state.commands.push({ type: 'CompleteWorkflow', seq, result: { ok: result } });
    })
    .catch((error: any) => {
      const seq = state.nextSeq++;
      state.commands.push({ type: 'CompleteWorkflow', seq, result: { error } });
    });
}

export function getAndResetCommands() {
  const { commands } = state;
  state.commands = [];
  return commands;
}

export function initWorkflow(id: string): void {
  Math.random = alea(id);
}
