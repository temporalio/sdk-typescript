/**
 * Client-side LangSmith interceptor.
 *
 * Runs in the real Node process (not the workflow isolate), so it uses the real
 * LangSmith `Client` directly and reads the ambient run from LangSmith's real
 * async-context store (`getCurrentRunTree`). This is the entry point for trace
 * context that originates *outside* Temporal — a user who calls
 * `client.workflow.start(...)` (or `signal` / `query` / `startUpdate`) from
 * inside their own `traceable` gets that trace propagated into the workflow.
 *
 * Two propagation shapes, matching the workflow-side interceptors:
 *
 *  - **Execution** ops (`start`): emit a `StartWorkflow:` marker as a *peer*
 *    child of the ambient run and propagate the **ambient** context, so the
 *    remote `RunWorkflow:` becomes a sibling of the marker (both children of
 *    the ambient). With no ambient, the marker is a root and nothing is
 *    propagated, so `RunWorkflow:` is a separate root.
 *  - **Messaging** ops (`signal`, `signalWithStart`, `query`, `startUpdate`,
 *    `startUpdateWithStart`): emit the marker and propagate the **marker**
 *    context, so the remote `Handle*:` / `Validate*:` runs nest *under* the
 *    marker.
 *
 * Lifecycle ops (`terminate`, `cancel`, `describe`) pass through untouched:
 * they neither emit a run nor inject a header.
 *
 * @module
 */

import type { Payload } from '@temporalio/common';
import { RunTree } from 'langsmith/run_trees';
import { getCurrentRunTree } from 'langsmith/traceable';
import type { Client } from 'langsmith';

import {
  isTracingEnabled,
  scrubSensitive,
  withContextHeader,
  type LangSmithTraceContext,
} from './propagation';
import {
  RUN_TYPE,
  queryWorkflowRunName,
  signalWithStartRunName,
  signalWorkflowRunName,
  startUpdateWithStartRunName,
  startWorkflowRunName,
  startWorkflowUpdateRunName,
} from './run-tree';
import type { EmitterConfig } from './sinks';

type Headers = Record<string, Payload>;
type NextFn<I, O> = (input: I) => Promise<O>;

/** Local structural views of the client interceptor inputs (only fields we read). */
interface WithHeaders {
  readonly headers: Headers;
  readonly args?: unknown[];
}
interface StartInput extends WithHeaders {
  readonly workflowType: string;
}
interface SignalInput extends WithHeaders {
  readonly signalName: string;
}
interface SignalWithStartInput extends WithHeaders {
  readonly workflowType: string;
  readonly signalName: string;
}
interface QueryInput extends WithHeaders {
  readonly queryName: string;
}
interface UpdateInput extends WithHeaders {
  readonly updateName?: string;
  readonly name?: string;
}

function updateName(input: UpdateInput): string {
  return input.updateName ?? input.name ?? 'update';
}

/**
 * Build a LangSmith run for a client-side Temporal-operation marker, parented
 * under the ambient run when present. The run is always wired to the
 * plugin-configured client so emission is captured by whatever client the user
 * passed (a real LangSmith client in production, a collector in tests).
 */
function buildRun(
  config: EmitterConfig,
  ambient: RunTree | undefined,
  name: string,
  inputs: Record<string, unknown>,
): RunTree {
  return new RunTree({
    name,
    run_type: RUN_TYPE.CHAIN,
    inputs,
    parent_run: ambient,
    client: config.client as unknown as Client,
    project_name: config.projectName ?? ambient?.project_name,
    tags: config.defaultTags,
    extra: { metadata: scrubSensitive(config.defaultMetadata) ?? {} },
    tracingEnabled: true,
  });
}

/** Post + close a marker run (a parent may close before its remote children). */
async function emitMarker(run: RunTree): Promise<void> {
  await run.postRun();
  await run.end({});
  await run.patchRun();
}

function headersOf(run: RunTree | undefined): LangSmithTraceContext | undefined {
  return run ? (run.toHeaders() as LangSmithTraceContext) : undefined;
}

/**
 * Build the client-side LangSmith interceptor. Returned shape is structurally
 * the SDK's `WorkflowClientInterceptor`; methods the SDK does not recognize are
 * simply never invoked.
 */
export function createClientInterceptor(config: EmitterConfig): Record<string, unknown> {
  /** Execution op: marker is a peer of the remote run; propagate the ambient. */
  const peerStart = async <O>(
    input: StartInput,
    next: NextFn<StartInput, O>,
    name: string,
  ): Promise<O> => {
    if (!isTracingEnabled()) {
      return next(input);
    }
    const ambient = getCurrentRunTree(true);
    if (config.addTemporalRuns) {
      await emitMarker(buildRun(config, ambient, name, { args: input.args ?? [] }));
    }
    const headers = withContextHeader(input.headers, headersOf(ambient));
    return next({ ...input, headers });
  };

  /** Messaging op: remote handler nests under the marker; propagate the marker. */
  const parentMessage = async <I extends WithHeaders, O>(
    input: I,
    next: NextFn<I, O>,
    name: string,
  ): Promise<O> => {
    if (!isTracingEnabled()) {
      return next(input);
    }
    const ambient = getCurrentRunTree(true);
    let propagate: RunTree | undefined = ambient;
    if (config.addTemporalRuns) {
      const marker = buildRun(config, ambient, name, { args: input.args ?? [] });
      await emitMarker(marker);
      propagate = marker;
    }
    const headers = withContextHeader(input.headers, headersOf(propagate));
    return next({ ...input, headers });
  };

  return {
    start(input: StartInput, next: NextFn<StartInput, string>): Promise<string> {
      return peerStart(input, next, startWorkflowRunName(input.workflowType));
    },
    // `startWithDetails` is the descriptor-returning variant of `start`; it
    // propagates identically (peer marker + ambient context). Typed loosely on
    // its output because the descriptor shape varies across SDK versions.
    startWithDetails<O>(input: StartInput, next: NextFn<StartInput, O>): Promise<O> {
      return peerStart(input, next, startWorkflowRunName(input.workflowType));
    },
    signal(input: SignalInput, next: NextFn<SignalInput, void>): Promise<void> {
      return parentMessage(input, next, signalWorkflowRunName(input.signalName));
    },
    signalWithStart(
      input: SignalWithStartInput,
      next: NextFn<SignalWithStartInput, string>,
    ): Promise<string> {
      return parentMessage(input, next, signalWithStartRunName(input.workflowType));
    },
    query(input: QueryInput, next: NextFn<QueryInput, unknown>): Promise<unknown> {
      return parentMessage(input, next, queryWorkflowRunName(input.queryName));
    },
    startUpdate(input: UpdateInput, next: NextFn<UpdateInput, unknown>): Promise<unknown> {
      return parentMessage(input, next, startWorkflowUpdateRunName(updateName(input)));
    },
    startUpdateWithStart(
      input: UpdateInput,
      next: NextFn<UpdateInput, unknown>,
    ): Promise<unknown> {
      return parentMessage(input, next, startUpdateWithStartRunName(updateName(input)));
    },
    // Lifecycle operations carry no trace context and emit no run.
    terminate<I, O>(input: I, next: NextFn<I, O>): Promise<O> {
      return next(input);
    },
    cancel<I, O>(input: I, next: NextFn<I, O>): Promise<O> {
      return next(input);
    },
    describe<I, O>(input: I, next: NextFn<I, O>): Promise<O> {
      return next(input);
    },
  };
}
