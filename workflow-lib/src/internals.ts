/// Internals manipulate the Global object, track callbacks, accumulate commands, and provide an interface for interacting with sdk-core.
import * as iface from '../../proto/core_interface';
import { alea } from './alea';

/**
 * Track command sequences and callbacks, accumulate commands
 */
export const state = {
  callbacks: new Map<number, [Function, Function]>(),
  commands: new Array<iface.coresdk.ICommand>(),
  nextSeq: 0,
  /**
   * This is set every time the workflow executes a task
   */
  now: 0,
};

export function tsToMs(ts: iface.google.protobuf.ITimestamp | null | undefined) {
  if (ts === undefined || ts === null) {
    throw new Error(`Expected timestamp, got ${ts}`);
  }
  const { seconds, nanos } = ts;
  // TODO: seconds could be bigint | long | null | undeinfed
  return (seconds as number) * 1000 + Math.round((nanos || 0) / 1000000);
}

export function trigger(task: iface.coresdk.IWorkflowTask) {
  state.now = tsToMs(task.timestamp);
  if (task.unblockTimer) { // TODO: handle other attribute types
    const taskSeq = parseInt(task.unblockTimer.timerId!);
    const callbacks = state.callbacks.get(taskSeq);
    if (callbacks === undefined) {
      throw new Error(`No callback for taskSeq ${taskSeq}`);
    }
    const [callback] = callbacks;
    callback();
  }
}

// TODO: improve this definition
export interface Workflow {
  main(...args: any[]): Promise<any>;
}

export function runWorkflow({ main }: Workflow, timestamp: number) {
  state.now = timestamp;
  main()
    .then((_result: any) => {
      state.nextSeq++;
      state.commands.push({
        api: {
          commandType: iface.temporal.api.enums.v1.CommandType.COMMAND_TYPE_COMPLETE_WORKFLOW_EXECUTION,
          completeWorkflowExecutionCommandAttributes: {
            result: { /* TODO: payloads */ },
          },
        },
      });
    })
    .catch((error: any) => {
      state.nextSeq++;
      state.commands.push({
        api: {
          commandType: iface.temporal.api.enums.v1.CommandType.COMMAND_TYPE_FAIL_WORKFLOW_EXECUTION,
          failWorkflowExecutionCommandAttributes: {
            failure: { message: error.message }, // TODO: stackTrace
          },
        },
      });
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
