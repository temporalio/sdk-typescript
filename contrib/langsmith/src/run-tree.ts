/**
 * Replay-safe LangSmith run construction for workflow code, plus the pure
 * run-name builders shared by every interceptor.
 *
 * Inside the Temporal workflow isolate two things make LangSmith's default
 * `RunTree` unsafe to use directly:
 *
 *  1. **Non-deterministic ids.** `RunTree` defaults its id to a random-tailed
 *     uuid7. On replay the random tail differs, so every replay would mint a
 *     fresh run id and flood the backend with duplicates.
 *  2. **Network I/O on replay.** `postRun` / `patchRun` would re-POST runs to
 *     LangSmith on every history replay.
 *
 * {@link ReplaySafeRunTree} fixes both: ids come from Temporal's deterministic
 * `uuid4()`, timestamps from the isolate's deterministic clock, and the I/O
 * methods route through a Temporal Sink (so the actual HTTP call happens in the
 * worker process) and are suppressed entirely while replaying.
 *
 * This module is import-safe in the worker process too — the run-name builders
 * and {@link serializeRun} are pure, and the workflow-only helpers
 * (`workflowInfo`, `uuid4`, `proxySinks`) are only touched from
 * {@link ReplaySafeRunTree} methods, which are only ever constructed inside a
 * workflow.
 *
 * @module
 */

import { ApplicationFailure, ApplicationFailureCategory } from '@temporalio/common';
import { proxySinks, uuid4, workflowInfo } from '@temporalio/workflow';
import { RunTree, convertToDottedOrderFormat, type RunTreeConfig } from 'langsmith/run_trees';
import type { Client } from 'langsmith';

import { scrubSensitive } from './propagation';
import type { LangSmithSinks, SerializedRun } from './sinks';

/** LangSmith run-type constants used for Temporal-operation runs. */
export const RUN_TYPE = {
  /** Workflow / child-workflow / scheduling / handler spans. */
  CHAIN: 'chain',
  /** Activity-body execution spans. */
  TOOL: 'tool',
} as const;

// ---------------------------------------------------------------------------
// Run-name builders (pure; safe in any context).
// ---------------------------------------------------------------------------

/** `StartWorkflow:<type>` — client/parent-side workflow-start marker. */
export const startWorkflowRunName = (workflowType: string): string => `StartWorkflow:${workflowType}`;
/** `RunWorkflow:<type>` — the workflow-execution span (inbound). */
export const runWorkflowRunName = (workflowType: string): string => `RunWorkflow:${workflowType}`;
/** `StartActivity:<name>` — workflow-side activity-schedule marker. */
export const startActivityRunName = (activityType: string): string => `StartActivity:${activityType}`;
/** `RunActivity:<name>` — the activity-execution span (activity inbound). */
export const runActivityRunName = (activityType: string): string => `RunActivity:${activityType}`;
/** `StartChildWorkflow:<type>` — workflow-side child-start marker. */
export const startChildWorkflowRunName = (workflowType: string): string =>
  `StartChildWorkflow:${workflowType}`;
/** `ContinueAsNew:<type>` — continue-as-new marker. */
export const continueAsNewRunName = (workflowType: string): string => `ContinueAsNew:${workflowType}`;
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
export const signalChildWorkflowRunName = (signalName: string): string =>
  `SignalChildWorkflow:${signalName}`;
/** `SignalExternalWorkflow:<name>` — workflow-side signal-external marker. */
export const signalExternalWorkflowRunName = (signalName: string): string =>
  `SignalExternalWorkflow:${signalName}`;
/** `SignalWithStartWorkflow:<type>` — client signal-with-start marker. */
export const signalWithStartRunName = (workflowType: string): string =>
  `SignalWithStartWorkflow:${workflowType}`;
/** `QueryWorkflow:<name>` — client query marker. */
export const queryWorkflowRunName = (queryName: string): string => `QueryWorkflow:${queryName}`;
/** `StartWorkflowUpdate:<name>` — client update-start marker. */
export const startWorkflowUpdateRunName = (updateName: string): string =>
  `StartWorkflowUpdate:${updateName}`;
/** `StartUpdateWithStartWorkflow:<name>` — client update-with-start marker. */
export const startUpdateWithStartRunName = (updateName: string): string =>
  `StartUpdateWithStartWorkflow:${updateName}`;

// ---------------------------------------------------------------------------
// Workflow-isolate determinism helpers (only called inside a workflow).
// ---------------------------------------------------------------------------

/**
 * Deterministic current time (epoch ms) from the isolate clock.
 *
 * Uses `Date.now()` rather than `workflowInfo().unsafe.now()`: inside the
 * workflow isolate the Temporal SDK shims `Date.now()` to a value that is set
 * on the first invocation of each Workflow Task and stays constant for the
 * duration of the task and during replay — exactly the replay-safe clock we
 * need. `unsafe.now()` is, by contrast, the *non-deterministic* real wall
 * clock (and is not even exposed as a callable in every SDK build), so it must
 * never drive run timestamps. In the worker process (activity/client paths
 * import this module too) `Date.now()` is ordinary wall time, which is correct
 * there since those paths are never replayed.
 */
function nowMs(): number {
  return Date.now();
}

/**
 * True only while the workflow task is replaying genuine **history events** —
 * the exact condition under which emission must be suppressed to avoid
 * duplicate runs.
 *
 * Deliberately reads `isReplayingHistoryEvents`, NOT `isReplaying`. The two
 * differ for live read-only operations (query handlers and update validators):
 * there `isReplaying` is `true` (state is being rebuilt) but
 * `isReplayingHistoryEvents` is `false`, because the handler itself is a live
 * call that should produce a run. The Temporal SDK gates `callDuringReplay:
 * false` sinks on `isReplayingHistoryEvents`, so matching it here keeps our
 * in-isolate suppression consistent with sink dispatch — a live `HandleQuery:`
 * run is emitted, while runs are still suppressed during true history replay.
 */
function isReplaying(): boolean {
  return workflowInfo().unsafe.isReplayingHistoryEvents;
}

/** A fresh deterministic run id seeded off the workflow's PRNG. */
function newRunId(): string {
  return uuid4();
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
export function serializeRun(run: RunTree): SerializedRun {
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

/**
 * A {@link RunTree} subclass safe to construct and drive from workflow code.
 *
 * Composition was considered (per the "wrap, don't subclass" guidance) but
 * rejected here for one concrete reason: LangSmith's native `traceable`
 * resolves its parent with `isRunTree(getCurrentRunTree())` and then calls
 * `parent.createChild(...)`. A plain wrapper fails the `instanceof RunTree`
 * check, so `traceable` would refuse to nest under it. We therefore subclass,
 * but inject all non-deterministic values **through the constructor config**
 * (never via retroactive `defineProperty`), and override only `createChild`
 * (to keep children replay-safe) and the three I/O methods.
 */
export class ReplaySafeRunTree extends RunTree {
  constructor(config: RunTreeConfig) {
    super(ReplaySafeRunTree.fill(config));
  }

  private static fill(config: RunTreeConfig): RunTreeConfig {
    const id = config.id ?? newRunId();
    const start_time = config.start_time ?? nowMs();
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
    const id = config.id ?? newRunId();
    const start_time = config.start_time ?? nowMs();
    const child = new ReplaySafeRunTree({
      ...config,
      id,
      start_time,
      run_type: config.run_type ?? RUN_TYPE.CHAIN,
      parent_run: this,
      parent_run_id: this.id,
      trace_id: this.trace_id,
      project_name: config.project_name ?? this.project_name,
    });
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

  /**
   * Record end-time / outputs / error on the run object (pure, replay-safe),
   * then let `traceable` call {@link patchRun} to emit. We deliberately do not
   * call `super.end()`'s implicit network path; field assignment only.
   */
  override async end(outputs?: Record<string, unknown>, error?: string, endTime?: number): Promise<void> {
    if (outputs !== undefined) {
      this.outputs = outputs;
    }
    if (error !== undefined) {
      this.error = error;
    }
    this.end_time = endTime ?? nowMs();
  }
}

/**
 * Build a replay-safe **root** run for a Temporal operation, optionally nested
 * under a reconstructed parent context.
 */
export function newRun(config: RunTreeConfig): ReplaySafeRunTree {
  return new ReplaySafeRunTree(config);
}
