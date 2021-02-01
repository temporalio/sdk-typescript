/// Internals manipulate the Global object, track callbacks, accumulate commands, and provide an interface for interacting with sdk-core.
import * as iface from '../../proto/core_interface';
import { alea } from './alea';
import { Workflow } from './types';

/**
 * Track command sequences and callbacks, accumulate commands
 */
export interface State {
  callbacks: Map<number, [Function, Function]>;
  commands: iface.coresdk.ICommand[];
  nextSeq: number;
  /**
   * This is set every time the workflow executes a task
   */
  now: number;
  workflow?: Workflow,
  activator?: Activator,
};

export const state: State = {
  callbacks: new Map(),
  commands: new Array(),
  nextSeq: 0,
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

export type HandlerFunction = (task: iface.coresdk.WorkflowTask) => void;
export type WorkflowTaskHandler = Record<Exclude<iface.coresdk.WorkflowTask['attributes'], undefined>, HandlerFunction>;

export class Activator implements WorkflowTaskHandler {
  public startWorkflow(task: iface.coresdk.WorkflowTask): void {
    if (state.workflow === undefined) {
      throw new Error('state.workflow is not defined');
    }
    state.workflow.main(...(task.startWorkflow?.arguments?.payloads || [])) // TODO: deserialize payloads
      .then((_result: any) => {
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

  public unblockTimer(task: iface.coresdk.WorkflowTask): void {
    const taskSeq = parseInt(task.unblockTimer!.timerId!); // TODO: improve types to get rid of !
    const callbacks = state.callbacks.get(taskSeq);
    if (callbacks === undefined) {
      throw new Error(`No callback for taskSeq ${taskSeq}`);
    }
    const [callback] = callbacks;
    callback();
  }
};

export function activate(arr: Uint8Array) {
  const task = iface.coresdk.WorkflowTask.decodeDelimited(arr);
  state.now = tsToMs(task.timestamp);
  if (state.activator === undefined) {
    throw new Error('state.activator is not defined');
  }
  if (task.attributes === undefined) {
    throw new Error('Expected workflow attributes to be defined');
  }
  state.activator[task.attributes](task);
}

export function concludeActivation(taskToken: Uint8Array) {
  const { commands } = state;
  // TODO: activation failed (should this be done in main node isolate?)
  const encoded = iface.coresdk.CompleteTaskReq.encodeDelimited({
    taskToken,
    workflow: { successful: { commands } },
  }).finish();
  state.commands = [];
  return encoded;
}

export function initWorkflow(id: string): void {
  Math.random = alea(id);
}

export function registerWorkflow(workflow: Workflow): void {
  state.workflow = workflow;
  state.activator = new Activator();
}
