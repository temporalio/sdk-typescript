/**
 * Worker-side LangSmith emission, exposed as a Temporal {@link InjectedSinks}.
 *
 * Workflow code runs in a deterministic V8 isolate that cannot perform network
 * I/O. Sinks are the canonical bridge: the workflow-side interceptors build a
 * {@link SerializedRun} and call a sink function, and the worker process (real
 * Node, holding the real LangSmith `Client`) performs the `createRun` /
 * `updateRun` HTTP call out of the isolate.
 *
 * Replay safety: both sink functions are registered with
 * `callDuringReplay: false`, so history replay never re-emits a run. Combined
 * with deterministic run IDs (see `run-tree.ts`) this gives the
 * try-for-exactly-once delivery the plugin promises.
 *
 * @module
 */

import type { Sinks } from '@temporalio/workflow';
import type { InjectedSinks } from '@temporalio/worker';
import type { LangSmithTracingClientInterface } from 'langsmith';

import { isTracingEnabled } from './propagation';

/**
 * Plain-JSON description of a LangSmith run as it crosses the isolate→worker
 * boundary. Every field is structurally serializable so it survives the sink
 * transport. This is the union of what `Client.createRun` and
 * `Client.updateRun` need.
 */
export interface SerializedRun {
  /** Deterministic run id (from Temporal `uuid4()` inside a workflow). */
  id: string;
  /** Trace id — the root run id for this trace. */
  trace_id: string;
  /** LangSmith dotted-order string encoding the run's position in the trace. */
  dotted_order: string;
  /** Parent run id, when this run is nested. */
  parent_run_id?: string;
  /** Display name, e.g. `RunActivity:my_activity`. */
  name: string;
  /** LangSmith run type (`chain`, `tool`, `llm`, ...). */
  run_type: string;
  /** Deterministic start time (epoch ms). */
  start_time: number;
  /** End time (epoch ms); present only on the update record. */
  end_time?: number;
  /** Structured inputs. */
  inputs?: Record<string, unknown>;
  /** Structured outputs (update record). */
  outputs?: Record<string, unknown>;
  /** Error string; non-null marks the run errored. */
  error?: string;
  /** Extra payload (carries `metadata`). */
  extra?: Record<string, unknown>;
  /** Run tags. */
  tags?: string[];
  /** Target LangSmith project. */
  project_name?: string;
  /** Streaming / lifecycle events (e.g. `new_token`). */
  events?: Record<string, unknown>[];
}

/**
 * Runtime configuration shared by the client and activity interceptors, which
 * emit LangSmith runs directly (real Node context, real client) rather than
 * through the workflow Sink.
 */
export interface EmitterConfig {
  /** The LangSmith client runs are emitted to. */
  client: LangSmithTracingClientInterface;
  /** When false, no Temporal-operation runs are emitted (propagation only). */
  addTemporalRuns: boolean;
  /** Target LangSmith project. */
  projectName?: string;
  /** Tags attached to every emitted run. */
  defaultTags?: string[];
  /** Metadata merged into every emitted run. */
  defaultMetadata?: Record<string, unknown>;
}

/**
 * The Temporal sink surface this plugin injects. Workflow code calls these via
 * `proxySinks<LangSmithSinks>()`; the worker fulfils them via
 * {@link createLangSmithSinks}.
 */
export interface LangSmithSinks extends Sinks {
  langsmith: {
    /** Emit a `createRun` for a newly started run. */
    createRun(run: SerializedRun): void;
    /** Emit an `updateRun` (end / outputs / error / events) for a run. */
    updateRun(run: SerializedRun): void;
  };
}

function toCreateParams(run: SerializedRun): Parameters<LangSmithTracingClientInterface['createRun']>[0] {
  return {
    id: run.id,
    trace_id: run.trace_id,
    dotted_order: run.dotted_order,
    parent_run_id: run.parent_run_id,
    name: run.name,
    run_type: run.run_type,
    start_time: run.start_time,
    inputs: run.inputs ?? {},
    extra: run.extra,
    tags: run.tags,
    project_name: run.project_name,
  } as Parameters<LangSmithTracingClientInterface['createRun']>[0];
}

function toUpdateParams(run: SerializedRun): Parameters<LangSmithTracingClientInterface['updateRun']>[1] {
  return {
    end_time: run.end_time,
    outputs: run.outputs,
    error: run.error,
    extra: run.extra,
    tags: run.tags,
    events: run.events,
    dotted_order: run.dotted_order,
    trace_id: run.trace_id,
    parent_run_id: run.parent_run_id,
  } as Parameters<LangSmithTracingClientInterface['updateRun']>[1];
}

/**
 * Build the worker-side {@link InjectedSinks} that route serialized runs to a
 * real LangSmith client.
 *
 * Emission errors are swallowed: an observability backend hiccup must never
 * fail the user's workflow. Both functions are `callDuringReplay: false`.
 *
 * Exposed publicly as an advanced escape hatch for users who construct their
 * Worker's `sinks` by hand instead of letting {@link LangSmithPlugin} inject
 * them; merge the returned object into your own `InjectedSinks`.
 */
export function createLangSmithSinks(
  client: LangSmithTracingClientInterface,
): InjectedSinks<LangSmithSinks> {
  return {
    langsmith: {
      createRun: {
        fn: (_info, run) => {
          // Honor the LangSmith kill-switch at the real-env emission point.
          if (!isTracingEnabled()) {
            return;
          }
          void Promise.resolve(client.createRun(toCreateParams(run))).catch(() => {
            /* swallow: emission must never fail the workflow */
          });
        },
        callDuringReplay: false,
      },
      updateRun: {
        fn: (_info, run) => {
          if (!isTracingEnabled()) {
            return;
          }
          void Promise.resolve(client.updateRun(run.id, toUpdateParams(run))).catch(() => {
            /* swallow: emission must never fail the workflow */
          });
        },
        callDuringReplay: false,
      },
    },
  };
}
