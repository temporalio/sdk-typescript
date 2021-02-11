/// Internals manipulate the Global object, track callbacks, accumulate commands, and provide an interface for interacting with sdk-core.
import * as iface from '../../proto/core-interface';
import { defaultDataConverter, arrayFromPayloads } from './converter/data-converter';
import { alea } from './alea';
import { Workflow } from './interfaces';
import { tsToMs } from './time';

/**
 * Track command sequences and callbacks, accumulate commands
 */
export interface State {
  callbacks: Map<number, [Function, Function]>;
  commands: iface.coresdk.ICommand[];
  completed: boolean;
  nextSeq: number;
  /**
   * This is set every time the workflow executes an activation
   */
  now: number;
  workflow?: Workflow,
  activator?: Activator,
}

export const state: State = {
  callbacks: new Map(),
  commands: [],
  completed: false,
  nextSeq: 0,
  now: 0,
};

export type HandlerFunction<K extends keyof iface.coresdk.IWFActivationJob> =
  (activation: NonNullable<iface.coresdk.IWFActivationJob[K]>) => void;

export type WorkflowTaskHandler = {
  [P in keyof iface.coresdk.IWFActivationJob]: HandlerFunction<P>;
};

function completeWorkflow(result: any) {
  state.commands.push({
    api: {
      commandType: iface.temporal.api.enums.v1.CommandType.COMMAND_TYPE_COMPLETE_WORKFLOW_EXECUTION,
      completeWorkflowExecutionCommandAttributes: {
        result: defaultDataConverter.toPayloads(result),
      },
    },
  });
  state.completed = true;
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
  state.completed = true;
}

function completeQuery(result: any) {
  state.commands.push({
    core: {
      queryResult: {
        answer: { payloads: [defaultDataConverter.toPayload(result)] },
        resultType: iface.temporal.api.enums.v1.QueryResultType.QUERY_RESULT_TYPE_ANSWERED,
      },
    },
  });
}

function failQuery(error: any) {
  state.commands.push({
    core: {
      queryResult: {
        resultType: iface.temporal.api.enums.v1.QueryResultType.QUERY_RESULT_TYPE_FAILED,
        errorMessage: error.message,
      },
    },
  });
}

export class Activator implements WorkflowTaskHandler {
  public startWorkflow(activation: iface.coresdk.IStartWorkflowTaskAttributes): void {
    if (state.workflow === undefined) {
      throw new Error('state.workflow is not defined');
    }
    // TODO: support custom converter
    try {
      const retOrPromise = state.workflow.main(...arrayFromPayloads(defaultDataConverter, activation.arguments))
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

  public timerFired(activation: iface.coresdk.ITimerFiredTaskAttributes): void {
    if (!activation.timerId) {
      throw new Error('Got a TimerFired activation with no timerId');
    }
    const taskSeq = parseInt(activation.timerId);
    const callbacks = state.callbacks.get(taskSeq);
    if (callbacks === undefined) {
      throw new Error(`No callback for taskSeq ${taskSeq}`);
    }
    const [callback] = callbacks;
    callback();
  }

  public queryWorkflow(job: iface.coresdk.IQueryWorkflowJob): void {
    if (state.workflow === undefined) {
      throw new Error('state.workflow is not defined');
    }
    // TODO: support custom converter
    try {
      const { queries } = state.workflow;
      if (queries === undefined) {
        throw new Error('Workflow did not define any queries');
      }
      if (!job.query?.queryType) {
        throw new Error('Missing query type');
      }

      const fn = queries[job.query?.queryType];
      const retOrPromise = fn(...arrayFromPayloads(defaultDataConverter, job.query.queryArgs))
      if (retOrPromise instanceof Promise) {
        retOrPromise
          .then(completeQuery)
          .catch(failQuery);
      } else {
        completeQuery(retOrPromise);
      }
    } catch (err) {
      failQuery(err);
    }
  }
}

/**
 * @returns a boolean indicating whether the job was processed or ignored
 */
export function activate(encodedActivation: Uint8Array, jobIndex: number) {
  const activation = iface.coresdk.WFActivation.decodeDelimited(encodedActivation);
  // job's type is IWFActivationJob which doesn't have the `attributes` property.
  const job = activation.jobs[jobIndex] as iface.coresdk.WFActivationJob;
  state.now = tsToMs(activation.timestamp);
  if (state.activator === undefined) {
    throw new Error('state.activator is not defined');
  }
  if (job.attributes === undefined) {
    throw new Error('Expected job.attributes to be defined');
  }
  const attrs = job[job.attributes];
  if (!attrs) {
    throw new Error(`Expected job.${job.attributes} to be set`);
  }
  // The only job that can be executed on a completed workflow is a query.
  // We might get other jobs after completion for instance when a single
  // activation contains multiple jobs and the first one completes the workflow.
  if (state.completed && job.attributes !== 'queryWorkflow') {
    return false;
  }
  state.activator[job.attributes](attrs);
  return true;
}

export function concludeActivation(taskToken: Uint8Array) {
  const { commands } = state;
  // TODO: activation failed (should this be done in main node isolate?)
  const encoded = iface.coresdk.TaskCompletion.encodeDelimited({
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
