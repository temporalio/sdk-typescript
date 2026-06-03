/**
 * Activity-side and Nexus-handler-side LangSmith interceptors.
 *
 * Both run in the real Node worker process (activities and Nexus handlers are
 * never replayed deterministically), so they use the real LangSmith `Client`
 * and LangSmith's real async-context store via `withRunTree`. Installing the
 * run with `withRunTree` is what lets a user's *unchanged* `traceable` calls in
 * an activity / handler body nest under the Temporal-operation run with zero
 * code edits.
 *
 * Activity inbound reconstructs the propagated parent from the Payload-encoded
 * Temporal header; Nexus handlers reconstruct it from the plain-string Nexus
 * header (Nexus headers are not Payload-encoded).
 *
 * @module
 */

import type { Context as ActivityContext } from '@temporalio/activity';
import type { Payload } from '@temporalio/common';
import { RunTree } from 'langsmith/run_trees';
import { withRunTree } from 'langsmith/traceable';
import type { Client } from 'langsmith';

import {
  HEADER_KEY,
  decodeContextString,
  isTracingEnabled,
  readContextHeader,
  scrubSensitive,
  type LangSmithTraceContext,
} from './propagation';
import {
  RUN_TYPE,
  describeError,
  runActivityRunName,
  runCancelNexusHandlerRunName,
  runStartNexusHandlerRunName,
} from './run-tree';
import type { EmitterConfig } from './sinks';

type Headers = Record<string, Payload>;

interface ActivityExecuteInput {
  readonly args: unknown[];
  readonly headers: Headers;
}
type ActivityNext = (input: ActivityExecuteInput) => Promise<unknown>;

interface ActivityInboundInterceptor {
  execute?(input: ActivityExecuteInput, next: ActivityNext): Promise<unknown>;
}

/** Coerce an arbitrary activity/handler result into a LangSmith outputs object. */
function asOutputs(result: unknown): Record<string, unknown> {
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { result };
}

/**
 * Reconstruct the propagated parent run from a LangSmith trace context, wired to
 * the plugin-configured client so descendant runs emit to the right place. The
 * returned run is an *anchor* — never posted itself — used only as the parent
 * for the operation run (or directly as ambient when `addTemporalRuns` is off).
 */
function anchor(config: EmitterConfig, ctx: LangSmithTraceContext | undefined): RunTree | undefined {
  if (!ctx) {
    return undefined;
  }
  let parsed: RunTree | undefined;
  try {
    parsed = RunTree.fromHeaders(ctx as unknown as Record<string, string>) ?? undefined;
  } catch {
    parsed = undefined;
  }
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
    client: config.client as unknown as Client,
    // The user opted into tracing by installing the plugin, so body `traceable`
    // runs nested under this propagated parent must emit even if the worker's
    // process env hasn't independently enabled LangSmith. (Plugin-level kill
    // switch is enforced separately via `isTracingEnabled()`.)
    tracingEnabled: true,
  });
}

/**
 * Run `fn` with `op` installed as the active LangSmith run, emitting the run
 * around the call. Shared by activity and Nexus handlers.
 */
async function traceOperation(
  op: RunTree,
  fn: () => Promise<unknown>,
): Promise<unknown> {
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
export function createActivityInboundInterceptor(
  config: EmitterConfig,
): (ctx: ActivityContext) => ActivityInboundInterceptor {
  return (ctx: ActivityContext) => ({
    async execute(input: ActivityExecuteInput, next: ActivityNext): Promise<unknown> {
      if (!isTracingEnabled()) {
        return next(input);
      }
      const parent = anchor(config, readContextHeader(input.headers));
      if (!config.addTemporalRuns) {
        // Propagation only: nest the user's body `traceable` runs under the
        // reconstructed parent without emitting a Temporal-operation run.
        return parent ? withRunTree(parent, () => next(input)) : next(input);
      }
      const activityType = ctx.info.activityType;
      const run = new RunTree({
        name: runActivityRunName(activityType),
        run_type: RUN_TYPE.TOOL,
        inputs: { args: input.args },
        parent_run: parent,
        client: config.client as unknown as Client,
        project_name: config.projectName ?? parent?.project_name,
        tags: config.defaultTags,
        extra: { metadata: scrubSensitive(config.defaultMetadata) ?? {} },
        tracingEnabled: true,
      });
      return traceOperation(run, () => next(input));
    },
  });
}

// ---------------------------------------------------------------------------
// Nexus handler interceptor.
//
// Nexus headers cross the wire as a plain `Record<string, string>` (no Payload
// encoding), so the trace context is decoded from its JSON-string form. The
// exact Nexus inbound interceptor surface is newer and less stable than the
// activity surface, so this is typed against local structural views and wired
// defensively by the plugin.
// ---------------------------------------------------------------------------

interface NexusOperationInput {
  readonly service: string;
  readonly operation: string;
  readonly headers?: Record<string, string>;
}
type NexusNext = (input: NexusOperationInput) => Promise<unknown>;

interface NexusInboundInterceptor {
  startOperation?(input: NexusOperationInput, next: NexusNext): Promise<unknown>;
  cancelOperation?(input: NexusOperationInput, next: NexusNext): Promise<unknown>;
}

function nexusContext(input: NexusOperationInput): LangSmithTraceContext | undefined {
  return decodeContextString(input.headers?.[HEADER_KEY]);
}

/**
 * Build the Nexus-handler interceptor. `startOperation` opens a
 * `RunStartNexusOperationHandler:` run (so workflows the handler starts nest
 * under it); `cancelOperation` opens `RunCancelNexusOperationHandler:`.
 */
export function createNexusInboundInterceptor(config: EmitterConfig): NexusInboundInterceptor {
  const handle = (nameOf: (s: string, o: string) => string) =>
    async (input: NexusOperationInput, next: NexusNext): Promise<unknown> => {
      if (!isTracingEnabled()) {
        return next(input);
      }
      const parent = anchor(config, nexusContext(input));
      if (!config.addTemporalRuns) {
        return parent ? withRunTree(parent, () => next(input)) : next(input);
      }
      const run = new RunTree({
        name: nameOf(input.service, input.operation),
        run_type: RUN_TYPE.CHAIN,
        parent_run: parent,
        client: config.client as unknown as Client,
        project_name: config.projectName ?? parent?.project_name,
        tags: config.defaultTags,
        extra: { metadata: scrubSensitive(config.defaultMetadata) ?? {} },
      });
      return traceOperation(run, () => next(input));
    };

  return {
    startOperation: handle(runStartNexusHandlerRunName),
    cancelOperation: handle(runCancelNexusHandlerRunName),
  };
}
