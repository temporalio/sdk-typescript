/**
 * Replay-safe LangSmith run construction for workflow code, plus the pure
 * run-name builders shared by every interceptor.
 *
 * Inside the workflow isolate LangSmith's default `RunTree` is unsafe on two
 * counts that {@link ReplaySafeRunTree} fixes:
 *
 *  1. **Non-deterministic ids.** Its default random-tailed uuid7 would mint a
 *     fresh id on every replay, flooding the backend with duplicates.
 *  2. **Network I/O on replay.** `postRun` / `patchRun` would re-POST runs on
 *     every history replay.
 *
 * Internal: every export here is consumed only by sibling modules in this
 * package; none is reachable through a package entry point.
 *
 * @module
 * @internal
 */

import { RunTree, convertToDottedOrderFormat, type RunTreeConfig } from 'langsmith/run_trees';
import type { Client } from 'langsmith';
import { ApplicationFailure, ApplicationFailureCategory } from '@temporalio/common';
import { proxySinks, uuid4, workflowInfo } from '@temporalio/workflow';

import { uuid4FromRandom } from './prng';
import { scrubSensitive, type LangSmithTraceContext } from './propagation';
import type { EmitterConfig, LangSmithSinks, SerializedRun } from './sinks';

/** LangSmith run-type constants used for Temporal-operation runs. */
export const RUN_TYPE = {
  /** Workflow / child-workflow / scheduling / handler spans. */
  CHAIN: 'chain',
  /** Activity-body execution spans. */
  TOOL: 'tool',
} as const;

/** `StartWorkflow:<type>` — client/parent-side workflow-start marker. */
export const startWorkflowRunName = (workflowType: string): string => `StartWorkflow:${workflowType}`;
/** `RunWorkflow:<type>` — the workflow-execution span (inbound). */
export const runWorkflowRunName = (workflowType: string): string => `RunWorkflow:${workflowType}`;
/** `StartActivity:<name>` — workflow-side activity-schedule marker. */
export const startActivityRunName = (activityType: string): string => `StartActivity:${activityType}`;
/** `RunActivity:<name>` — the activity-execution span (activity inbound). */
export const runActivityRunName = (activityType: string): string => `RunActivity:${activityType}`;
/** `StartChildWorkflow:<type>` — workflow-side child-start marker. */
export const startChildWorkflowRunName = (workflowType: string): string => `StartChildWorkflow:${workflowType}`;
/** `StartNexusOperation:<service>/<op>` — workflow-side Nexus-start marker. */
export const startNexusOperationRunName = (service: string, operation: string): string =>
  `StartNexusOperation:${service}/${operation}`;
/** `RunStartNexusOperationHandler:<service>/<op>` — Nexus start-handler span. */
export const runStartNexusHandlerRunName = (service: string, operation: string): string =>
  `RunStartNexusOperationHandler:${service}/${operation}`;
/** `RunCancelNexusOperationHandler:<service>/<op>` — Nexus cancel-handler span. */
export const runCancelNexusHandlerRunName = (service: string, operation: string): string =>
  `RunCancelNexusOperationHandler:${service}/${operation}`;
/** `HandleSignal:<name>` — inbound signal handler span. */
export const handleSignalRunName = (signalName: string): string => `HandleSignal:${signalName}`;
/** `HandleQuery:<name>` — inbound query handler span. */
export const handleQueryRunName = (queryName: string): string => `HandleQuery:${queryName}`;
/** `HandleUpdate:<name>` — inbound update handler span. */
export const handleUpdateRunName = (updateName: string): string => `HandleUpdate:${updateName}`;
/** `ValidateUpdate:<name>` — inbound update validator span. */
export const validateUpdateRunName = (updateName: string): string => `ValidateUpdate:${updateName}`;
/** `SignalWorkflow:<name>` — client/outbound signal marker. */
export const signalWorkflowRunName = (signalName: string): string => `SignalWorkflow:${signalName}`;
/** `SignalChildWorkflow:<name>` — workflow-side signal-child marker. */
export const signalChildWorkflowRunName = (signalName: string): string => `SignalChildWorkflow:${signalName}`;
/** `SignalExternalWorkflow:<name>` — workflow-side signal-external marker. */
export const signalExternalWorkflowRunName = (signalName: string): string => `SignalExternalWorkflow:${signalName}`;
/** `SignalWithStartWorkflow:<type>` — client signal-with-start marker. */
export const signalWithStartRunName = (workflowType: string): string => `SignalWithStartWorkflow:${workflowType}`;
/** `QueryWorkflow:<name>` — client query marker. */
export const queryWorkflowRunName = (queryName: string): string => `QueryWorkflow:${queryName}`;
/** `StartWorkflowUpdate:<name>` — client update-start marker. */
export const startWorkflowUpdateRunName = (updateName: string): string => `StartWorkflowUpdate:${updateName}`;
/** `StartUpdateWithStartWorkflow:<name>` — client update-with-start marker. */
export const startUpdateWithStartRunName = (updateName: string): string => `StartUpdateWithStartWorkflow:${updateName}`;

/**
 * True only while replaying genuine history events, when emission must be
 * suppressed. Deliberately `isReplayingHistoryEvents`, NOT `isReplaying`: for
 * live read-only handlers (queries, update validators) `isReplaying` is `true`
 * but `isReplayingHistoryEvents` is `false`, so their runs still emit. Matches
 * how the SDK gates `callDuringReplay: false` sinks.
 */
function isReplaying(): boolean {
  return workflowInfo().unsafe.isReplayingHistoryEvents;
}

let cachedSinks: LangSmithSinks | undefined;
/** Lazily-resolved workflow Sink proxy (must be called inside a workflow). */
function sinks(): LangSmithSinks {
  if (cachedSinks === undefined) {
    cachedSinks = proxySinks<LangSmithSinks>();
  }
  return cachedSinks;
}

/**
 * A no-op LangSmith client. {@link ReplaySafeRunTree} never lets the underlying
 * `RunTree` perform network I/O — emission goes through the Sink — so the
 * client it carries must do nothing and must never read env / open sockets
 * inside the isolate.
 */
const NOOP_CLIENT = {
  createRun: async (): Promise<void> => {},
  updateRun: async (): Promise<void> => {},
} as unknown as Client;

/** Flatten a {@link RunTree} into the plain wire shape consumed by the Sink. */
function serializeRun(run: RunTree): SerializedRun {
  const extra = run.extra ? { ...run.extra } : undefined;
  if (extra && extra.metadata && typeof extra.metadata === 'object') {
    extra.metadata = scrubSensitive(extra.metadata as Record<string, unknown>);
  }
  return {
    id: run.id,
    trace_id: run.trace_id,
    dotted_order: run.dotted_order,
    parent_run_id: run.parent_run_id,
    name: run.name,
    run_type: run.run_type,
    start_time: run.start_time,
    end_time: run.end_time,
    inputs: run.inputs as Record<string, unknown> | undefined,
    outputs: run.outputs as Record<string, unknown> | undefined,
    error: run.error,
    extra,
    tags: run.tags,
    project_name: run.project_name,
    events: run.events as Record<string, unknown>[] | undefined,
  };
}

/**
 * Render an error into the LangSmith `error` string, honoring Temporal's
 * benign-failure category.
 *
 * A `BENIGN`-category `ApplicationFailure` is an expected, non-alarming outcome
 * (e.g. a control-flow signal), so it leaves the run's `error` unset — matching
 * the Python plugin. All other failures produce `"<type>: <message>"`.
 */
export function describeError(err: unknown): string | undefined {
  if (err instanceof ApplicationFailure) {
    if (err.category === ApplicationFailureCategory.BENIGN) {
      return undefined;
    }
    return `${err.type ?? 'ApplicationError'}: ${err.message}`;
  }
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

/** Coerce an arbitrary operation result into a LangSmith outputs object. */
export function asOutputs(result: unknown): Record<string, unknown> {
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { result };
}

/** The trace context to propagate for `run`, or `undefined` when absent. */
export function runHeaders(run: RunTree | undefined): LangSmithTraceContext | undefined {
  return run ? (run.toHeaders() as LangSmithTraceContext) : undefined;
}

/** Emit a short-lived marker run. */
export async function emitMarkerRun(marker: RunTree): Promise<void> {
  await marker.postRun();
  await marker.end({});
  await marker.patchRun();
}

/** Reconstruct a propagated parent {@link RunTree} from a trace context; never throws. */
export function runTreeFromContext(ctx: LangSmithTraceContext | undefined): RunTree | undefined {
  if (!ctx) {
    return undefined;
  }
  try {
    return RunTree.fromHeaders(ctx as unknown as Record<string, string>) ?? undefined;
  } catch {
    return undefined;
  }
}

interface RunTreeParams {
  name: string;
  runType: string;
  parent: RunTree | undefined;
  inputs?: Record<string, unknown>;
}

/**
 * Build an emitter-side {@link RunTree} (client / activity / Nexus); force-enables
 * tracing so nested body `traceable` runs emit — tracing gate is `isTracingEnabled()`.
 */
export function buildRunTree(config: EmitterConfig, params: RunTreeParams): RunTree {
  return new RunTree({
    name: params.name,
    run_type: params.runType,
    inputs: params.inputs ?? {},
    parent_run: params.parent,
    client: config.client,
    project_name: config.projectName ?? params.parent?.project_name,
    tags: config.defaultTags,
    extra: { metadata: scrubSensitive(config.defaultMetadata) ?? {} },
    tracingEnabled: true,
  });
}

/**
 * A {@link RunTree} subclass safe to construct and drive from workflow code.
 *
 * Subclasses rather than wraps because LangSmith's `traceable` resolves its
 * parent with `instanceof RunTree` before calling `parent.createChild(...)`, so
 * a plain wrapper would refuse to nest under it.
 *
 * @internal
 */
export class ReplaySafeRunTree extends RunTree {
  // Per-invocation run-id source. Seeded by read-only handlers (queries, update
  // validators) so their ids don't draw from the Workflow main PRNG; left
  // undefined on recorded paths, where id minting falls back to the main-PRNG
  // uuid4. Propagated to every child so the whole subtree draws from one source.
  protected readonly random?: () => number;

  constructor(config: RunTreeConfig, random?: () => number) {
    super(ReplaySafeRunTree.fill(config, random));
    this.random = random;
  }

  private static fill(config: RunTreeConfig, random?: () => number): RunTreeConfig {
    const id = config.id ?? (random ? uuid4FromRandom(random) : uuid4());
    const start_time = config.start_time ?? Date.now();
    const trace_id = config.trace_id ?? config.parent_run?.trace_id ?? id;
    let dotted_order = config.dotted_order;
    if (dotted_order == null) {
      const startMs = typeof start_time === 'number' ? start_time : Date.parse(String(start_time));
      const { dottedOrder } = convertToDottedOrderFormat(startMs, id);
      const parentDotted = config.parent_run?.dotted_order;
      dotted_order = parentDotted ? `${parentDotted}.${dottedOrder}` : dottedOrder;
    }
    return {
      ...config,
      id,
      start_time,
      trace_id,
      dotted_order,
      parent_run_id: config.parent_run_id ?? config.parent_run?.id,
      client: NOOP_CLIENT,
      tracingEnabled: config.tracingEnabled ?? true,
    };
  }

  /** Produce a replay-safe child so deeply-nested `traceable` runs stay deterministic. */
  override createChild(config: RunTreeConfig): ReplaySafeRunTree {
    const child = new ReplaySafeRunTree(
      {
        ...config,
        run_type: config.run_type ?? RUN_TYPE.CHAIN,
        parent_run: this,
        parent_run_id: this.id,
        trace_id: this.trace_id,
        project_name: config.project_name ?? this.project_name,
      },
      this.random
    );
    this.child_runs.push(child);
    return child;
  }

  /** Emit a `createRun` via the Sink, unless replaying. */
  override async postRun(): Promise<void> {
    if (isReplaying()) {
      return;
    }
    sinks().langsmith.createRun(serializeRun(this));
  }

  /** Record outputs/end-time locally then emit an `updateRun` via the Sink, unless replaying. */
  override async patchRun(): Promise<void> {
    if (isReplaying()) {
      return;
    }
    sinks().langsmith.updateRun(serializeRun(this));
  }

  /** Record end-time / outputs / error on the run object (pure, replay-safe). */
  override async end(outputs?: Record<string, unknown>, error?: string, endTime?: number): Promise<void> {
    if (outputs !== undefined) {
      this.outputs = outputs;
    }
    if (error !== undefined) {
      this.error = error;
    }
    this.end_time = endTime ?? Date.now();
  }
}

/**
 * A placeholder, never-emitted parent whose {@link createChild} produces
 * independent root children. Installed as the ambient so a workflow-body
 * `traceable` takes LangSmith's `createChild` branch (deterministic id) instead
 * of the no-parent branch that mints a uuid via `crypto`, which the isolate lacks.
 *
 * @internal
 */
export class _RootReplaySafeRunTreeFactory extends ReplaySafeRunTree {
  /** Produce a replay-safe child with no link back to this factory. */
  override createChild(config: RunTreeConfig): ReplaySafeRunTree {
    return new ReplaySafeRunTree(
      {
        ...config,
        run_type: config.run_type ?? RUN_TYPE.CHAIN,
        project_name: config.project_name ?? this.project_name,
      },
      this.random
    );
  }

  override async postRun(): Promise<void> {}

  override async patchRun(): Promise<void> {}
}
