/// Internals manipulate the Global object, track callbacks, accumulate commands, and provide an interface for interacting with sdk-core.
import * as iface from '../../proto/core-interface';
import { defaultDataConverter, arrayFromPayloads } from './converter/data-converter';
import { alea } from './alea';
import { Workflow } from './interfaces';

/**
 * Track command sequences and callbacks, accumulate commands
 */
export interface State {
  callbacks: Map<number, [Function, Function]>;
  commands: iface.coresdk.ICommand[];
  nextSeq: number;
  /**
   * This is set every time the workflow executes an activation
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
  return (seconds as number) * 1000 + Math.floor((nanos || 0) / 1000000);
}

export type HandlerFunction = (activation: iface.coresdk.WFActivation) => void;
export type WorkflowTaskHandler = Record<Exclude<iface.coresdk.WFActivation['attributes'], undefined>, HandlerFunction>;

function completeWorkflow(result: any) {
  state.commands.push({
    api: {
      commandType: iface.temporal.api.enums.v1.CommandType.COMMAND_TYPE_COMPLETE_WORKFLOW_EXECUTION,
      completeWorkflowExecutionCommandAttributes: {
        result: defaultDataConverter.toPayloads(result),
      },
    },
  });
}

function failWorkflow(error: any) {
  state.commands.push({
    api: {
      commandType: iface.temporal.api.enums.v1.CommandType.COMMAND_TYPE_FAIL_WORKFLOW_EXECUTION,
      failWorkflowExecutionCommandAttributes: {
        failure: { message: error.message }, // TODO: stackTrace
      },
    },
  });
}

export class Activator implements WorkflowTaskHandler {
  public startWorkflow(activation: iface.coresdk.WFActivation): void {
    if (state.workflow === undefined) {
      throw new Error('state.workflow is not defined');
    }
    // TODO: support custom converter
    try {
      const retOrPromise = state.workflow.main(...arrayFromPayloads(defaultDataConverter, activation.startWorkflow?.arguments))
      if (retOrPromise instanceof Promise) {
        retOrPromise
          .then(completeWorkflow)
          .catch(failWorkflow);
      } else {
        completeWorkflow(retOrPromise);
      }
    } catch (err) {
      failWorkflow(err);
    }
  }

  public unblockTimer(activation: iface.coresdk.WFActivation): void {
    const taskSeq = parseInt(activation.unblockTimer!.timerId!); // TODO: improve types to get rid of !
    const callbacks = state.callbacks.get(taskSeq);
    if (callbacks === undefined) {
      throw new Error(`No callback for taskSeq ${taskSeq}`);
    }
    const [callback] = callbacks;
    callback();
  }
};

export function activate(arr: Uint8Array) {
  const activation = iface.coresdk.WFActivation.decodeDelimited(arr);
  state.now = tsToMs(activation.timestamp);
  if (state.activator === undefined) {
    throw new Error('state.activator is not defined');
  }
  if (activation.attributes === undefined) {
    throw new Error('Expected workflow attributes to be defined');
  }
  state.activator[activation.attributes](activation);
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
