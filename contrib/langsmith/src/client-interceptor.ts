/**
 * Client-side LangSmith interceptor. Execution ops (`start`) emit a peer marker
 * and propagate the **ambient** context (the remote run is a sibling); messaging
 * ops (`signal`, `query`, `update`, …) emit the marker and propagate the
 * **marker** context (the remote handler nests under it).
 *
 * @module
 */

import { isTracingEnabled } from 'langsmith';
import type { RunTree } from 'langsmith/run_trees';
import { getCurrentRunTree } from 'langsmith/traceable';
import type { WorkflowClientInterceptor, WorkflowStartInput } from '@temporalio/client';

import { withContextHeader } from './propagation';
import {
  RUN_TYPE,
  buildRunTree,
  emitMarkerRun,
  queryWorkflowRunName,
  runHeaders,
  signalWithStartRunName,
  signalWorkflowRunName,
  startUpdateWithStartRunName,
  startWorkflowRunName,
  startWorkflowUpdateRunName,
} from './run-tree';
import type { EmitterConfig } from './sinks';

type NextFn<I, O> = (input: I) => Promise<O>;

export function createClientInterceptor(config: EmitterConfig): WorkflowClientInterceptor {
  const peerStart = async <I extends { headers: WorkflowStartInput['headers'] }, O>(
    input: I,
    next: NextFn<I, O>,
    name: string,
    args: unknown[]
  ): Promise<O> => {
    if (!isTracingEnabled()) {
      return next(input);
    }
    const ambient = getCurrentRunTree(true);
    if (config.addTemporalRuns) {
      await emitMarkerRun(buildRunTree(config, { name, runType: RUN_TYPE.CHAIN, parent: ambient, inputs: { args } }));
    }
    const headers = withContextHeader(input.headers, runHeaders(ambient));
    return next({ ...input, headers });
  };

  const parentMarker = async <I extends { headers: WorkflowStartInput['headers'] }, O>(
    input: I,
    next: NextFn<I, O>,
    name: string,
    args: unknown[]
  ): Promise<O> => {
    if (!isTracingEnabled()) {
      return next(input);
    }
    const ambient = getCurrentRunTree(true);
    let propagate: RunTree | undefined = ambient;
    if (config.addTemporalRuns) {
      const marker = buildRunTree(config, { name, runType: RUN_TYPE.CHAIN, parent: ambient, inputs: { args } });
      await emitMarkerRun(marker);
      propagate = marker;
    }
    const headers = withContextHeader(input.headers, runHeaders(propagate));
    return next({ ...input, headers });
  };

  return {
    start(input, next) {
      return peerStart(input, next, startWorkflowRunName(input.workflowType), input.options.args);
    },
    startWithDetails(input, next) {
      return peerStart(input, next, startWorkflowRunName(input.workflowType), input.options.args);
    },
    signal(input, next) {
      return parentMarker(input, next, signalWorkflowRunName(input.signalName), input.args);
    },
    signalWithStart(input, next) {
      return parentMarker(input, next, signalWithStartRunName(input.workflowType), input.signalArgs);
    },
    query(input, next) {
      return parentMarker(input, next, queryWorkflowRunName(input.queryType), input.args);
    },
    startUpdate(input, next) {
      return parentMarker(input, next, startWorkflowUpdateRunName(input.updateName), input.args);
    },
    async startUpdateWithStart(input, next) {
      if (!isTracingEnabled()) {
        return next(input);
      }
      const ambient = getCurrentRunTree(true);
      let propagate: RunTree | undefined = ambient;
      if (config.addTemporalRuns) {
        const marker = buildRunTree(config, {
          name: startUpdateWithStartRunName(input.updateName),
          runType: RUN_TYPE.CHAIN,
          parent: ambient,
          inputs: { args: input.updateArgs },
        });
        await emitMarkerRun(marker);
        propagate = marker;
      }
      const workflowStartHeaders = withContextHeader(input.workflowStartHeaders, runHeaders(propagate));
      return next({ ...input, workflowStartHeaders });
    },
  };
}
