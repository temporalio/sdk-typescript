/**
 * Activity-side and Nexus-handler-side LangSmith interceptors. Both run in the
 * real Node worker process and install the reconstructed run via `withRunTree`
 * so a user's unchanged body `traceable` calls nest under it.
 *
 * @module
 */

import { isTracingEnabled } from 'langsmith';
import { RunTree } from 'langsmith/run_trees';
import { withRunTree } from 'langsmith/traceable';
import type { Context as ActivityContext } from '@temporalio/activity';
import type { ActivityInboundCallsInterceptorFactory, NexusInboundCallsInterceptor } from '@temporalio/worker';

import { HEADER_KEY, decodeContextString, readContextHeader, type LangSmithTraceContext } from './propagation';
import {
  RUN_TYPE,
  asOutputs,
  describeError,
  buildRunTree,
  runActivityRunName,
  runCancelNexusHandlerRunName,
  runStartNexusHandlerRunName,
  runTreeFromContext,
} from './run-tree';
import type { EmitterConfig } from './sinks';

/**
 * Reconstruct the propagated parent run from a LangSmith trace context, wired to
 * the plugin-configured client so descendant runs emit to the right place. The
 * returned run is the *parent* — never posted itself — used only to parent
 * the operation run (or directly as ambient when `addTemporalRuns` is off).
 */
function reconstructParentRun(config: EmitterConfig, ctx: LangSmithTraceContext | undefined): RunTree | undefined {
  const parsed = runTreeFromContext(ctx);
  if (!parsed) {
    return undefined;
  }
  return new RunTree({
    name: parsed.name || 'parent',
    run_type: parsed.run_type || RUN_TYPE.CHAIN,
    id: parsed.id,
    trace_id: parsed.trace_id,
    dotted_order: parsed.dotted_order,
    parent_run_id: parsed.parent_run_id,
    project_name: config.projectName ?? parsed.project_name,
    client: config.client,
    // Force-enable so nested body `traceable` runs emit; tracing gate is `isTracingEnabled()`.
    tracingEnabled: true,
  });
}

/**
 * Run `fn` with `op` installed as the active LangSmith run, emitting the run
 * around the call. Shared by activity and Nexus handlers.
 */
async function traceOperation<T>(op: RunTree, fn: () => Promise<T>): Promise<T> {
  await op.postRun();
  try {
    const result = await withRunTree(op, fn);
    await op.end(asOutputs(result));
    await op.patchRun();
    return result;
  } catch (err) {
    await op.end(undefined, describeError(err));
    await op.patchRun();
    throw err;
  }
}

/**
 * Build the activity-inbound interceptor factory. The worker calls the factory
 * once per activity with that activity's {@link ActivityContext}, from which we
 * read the activity type for the run name.
 */
export function createActivityInboundInterceptor(config: EmitterConfig): ActivityInboundCallsInterceptorFactory {
  return (ctx: ActivityContext) => ({
    async execute(input, next) {
      if (!isTracingEnabled()) {
        return next(input);
      }
      const parent = reconstructParentRun(config, readContextHeader(input.headers));
      if (!config.addTemporalRuns) {
        // Propagation only: nest the user's body `traceable` runs under the
        // reconstructed parent without emitting a Temporal-operation run.
        // No propagated parent: run the body with no ambient run by design (nothing to attach to).
        return parent ? withRunTree(parent, () => next(input)) : next(input);
      }
      const activityType = ctx.info.activityType;
      const run = buildRunTree(config, {
        name: runActivityRunName(activityType),
        runType: RUN_TYPE.TOOL,
        parent,
        inputs: { args: input.args },
      });
      return traceOperation(run, () => next(input));
    },
  });
}

function nexusContext(headers: Record<string, string>): LangSmithTraceContext | undefined {
  return decodeContextString(headers[HEADER_KEY]);
}

/**
 * Build the Nexus-handler interceptor. `startOperation` opens a
 * `RunStartNexusOperationHandler:` run (so workflows the handler starts nest
 * under it); `cancelOperation` opens `RunCancelNexusOperationHandler:`.
 */
export function createNexusInboundInterceptor(config: EmitterConfig): NexusInboundCallsInterceptor {
  const handle = async <I extends { ctx: { service: string; operation: string; headers: Record<string, string> } }, O>(
    input: I,
    next: (input: I) => Promise<O>,
    nameOf: (s: string, o: string) => string
  ): Promise<O> => {
    if (!isTracingEnabled()) {
      return next(input);
    }
    const parent = reconstructParentRun(config, nexusContext(input.ctx.headers));
    if (!config.addTemporalRuns) {
      return parent ? withRunTree(parent, () => next(input)) : next(input);
    }
    const run = buildRunTree(config, {
      name: nameOf(input.ctx.service, input.ctx.operation),
      runType: RUN_TYPE.CHAIN,
      parent,
    });
    return traceOperation(run, () => next(input));
  };

  return {
    startOperation(input, next) {
      return handle(input, next, runStartNexusHandlerRunName);
    },
    cancelOperation(input, next) {
      return handle(input, next, runCancelNexusHandlerRunName);
    },
  };
}
