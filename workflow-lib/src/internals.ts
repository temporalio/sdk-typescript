/// Internals manipulate the Global object, track callbacks, accumulate commands, and provide an interface for interacting with sdk-core.
import { ActivityOptions } from './types';
import { alea } from './alea';

interface ScheduleTimerCommand {
  type: 'ScheduleTimer';
  seq: number;
  ms: number;
}

interface CancelTimerCommand {
  type: 'CancelTimer';
  seq: number;
  timerSeq: number;
}

interface ScheduleActivityCommand {
  type: 'ScheduleActivity';
  seq: number;
  module: string;
  name: string;
  arguments: any[];
  options: ActivityOptions;
}

type Result<R, E> = { ok: R } | { error: E };

interface CompleteWorkflowCommand {
  type: 'CompleteWorkflow';
  seq: number;
  result: Result<any, any>;
}

type Command = ScheduleTimerCommand | CancelTimerCommand | ScheduleActivityCommand | CompleteWorkflowCommand;

/**
 * Track command sequences and callbacks, accumulate commands
 */
export const state = {
  callbacks: new Map<number, [Function, Function]>(),
  commands: new Array<Command>(),
  nextSeq: 0,
};

export function trigger(task: any /* TODO */) {
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

export function runWorkflow({ main }: Workflow) {
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
