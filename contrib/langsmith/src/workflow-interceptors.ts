/**
 * Workflow-isolate interceptors and the LangSmith context provider. Loaded into
 * the workflow bundle (via the plugin's `workflowModules`) and runs entirely
 * inside the V8 isolate. Trace context propagates through the real,
 * async-context-tracking `AsyncLocalStorage` the SDK worker injects onto the
 * workflow-sandbox global; the plugin and LangSmith's own load-time init
 * converge on one shared store (see {@link sharedStore}).
 *
 * @module
 * @internal
 */

import type { RunTree } from 'langsmith/run_trees';
import { AsyncLocalStorageProviderSingleton } from 'langsmith/singletons/traceable';
import type {
  ContinueAsNewInput,
  Next,
  WorkflowExecuteInput,
  WorkflowInboundCallsInterceptor,
  WorkflowInterceptors,
  WorkflowOutboundCallsInterceptor,
} from '@temporalio/workflow';
import {
  workflowInfo,
  type ActivityInput,
  type Headers,
  type LocalActivityInput,
  type QueryInput,
  type SignalInput,
  type SignalWorkflowInput,
  type StartChildWorkflowExecutionInput,
  type StartNexusOperationInput,
  type StartNexusOperationOutput,
  type UpdateInput,
} from '@temporalio/workflow';
import {
  HEADER_KEY,
  encodeContextString,
  isInternalQuery,
  readContextHeader,
  scrubSensitive,
  withContextHeader,
} from './propagation';
import {
  ReplaySafeRunTree,
  _RootReplaySafeRunTreeFactory,
  RUN_TYPE,
  asOutputs,
  describeError,
  emitMarkerRun,
  handleQueryRunName,
  handleSignalRunName,
  handleUpdateRunName,
  runHeaders,
  runTreeFromContext,
  runWorkflowRunName,
  signalChildWorkflowRunName,
  signalExternalWorkflowRunName,
  startActivityRunName,
  startChildWorkflowRunName,
  startNexusOperationRunName,
  validateUpdateRunName,
} from './run-tree';

/**
 * Configuration the worker injects into the workflow bundle via the bundler's
 * `DefinePlugin`. Mirrors the user-facing plugin options that the workflow
 * isolate needs in order to decide whether to emit Temporal-operation runs.
 *
 * @internal
 */
export interface WorkflowLangSmithConfig {
  addTemporalRuns: boolean;
  projectName?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// Injected at bundle time by the plugin's DefinePlugin. Declared so the bare
// identifier is replaced textually (avoids the dotted-access DefinePlugin
// pitfall). Absent in environments that bundled without the plugin.
declare const __TEMPORAL_LANGSMITH_CONFIG__: string | undefined;

function readConfig(): WorkflowLangSmithConfig {
  try {
    if (typeof __TEMPORAL_LANGSMITH_CONFIG__ === 'string') {
      return JSON.parse(__TEMPORAL_LANGSMITH_CONFIG__) as WorkflowLangSmithConfig;
    }
  } catch {
    /* fall through to default */
  }
  return { addTemporalRuns: false };
}

/** The `getStore`/`run` slice of `AsyncLocalStorage` the interceptors and LangSmith share. */
interface RunTreeStore {
  getStore(): RunTree | undefined;
  run<T>(store: RunTree | undefined, fn: () => T): T;
}

// The SDK worker injects a real, async-context-tracking `AsyncLocalStorage` onto
// the workflow-sandbox global before the bundle evaluates. Bundler aliases (see
// plugin.ts) also route LangSmith's `new AsyncLocalStorage()` there, so both the
// plugin and LangSmith's load-time `initializeGlobalInstance` compete for one
// global slot (first writer wins). Install our instance, then read back whichever
// won so interceptors and `traceable` read/write the same store regardless of
// load order.
declare const globalThis: { AsyncLocalStorage: new () => RunTreeStore };
AsyncLocalStorageProviderSingleton.initializeGlobalInstance(
  new globalThis.AsyncLocalStorage() as Parameters<
    typeof AsyncLocalStorageProviderSingleton.initializeGlobalInstance
  >[0]
);
const sharedStore = AsyncLocalStorageProviderSingleton.getInstance() as RunTreeStore;

/** Reconstruct the propagated parent run from a Payload-keyed header map. */
function reconstructParent(headers: Record<string, unknown> | undefined): RunTree | undefined {
  return runTreeFromContext(readContextHeader(headers as Record<string, never> | undefined));
}

/**
 * Re-wrap a reconstructed (plain) parent so its `createChild` produces
 * replay-safe children. Carries the same id/trace/dotted so descendants parent
 * under the real propagated run; never emitted itself.
 */
function asReplaySafeParent(
  parent: RunTree | undefined,
  generateNewUuid4?: () => string
): ReplaySafeRunTree | undefined {
  if (!parent) {
    return undefined;
  }
  return new ReplaySafeRunTree(
    {
      name: parent.name,
      run_type: parent.run_type,
      id: parent.id,
      trace_id: parent.trace_id,
      dotted_order: parent.dotted_order,
      parent_run_id: parent.parent_run_id,
      project_name: parent.project_name,
    },
    generateNewUuid4
  );
}

/**
 * A placeholder parent for the no-propagated-parent case. Installed as the ambient
 * so a workflow-body `traceable` always nests via `createChild`; never emitted,
 * and its children are independent roots (see {@link _RootReplaySafeRunTreeFactory}).
 */
function placeholderRoot(generateNewUuid4?: () => string): _RootReplaySafeRunTreeFactory {
  return new _RootReplaySafeRunTreeFactory(
    { name: workflowInfo().workflowType, run_type: RUN_TYPE.CHAIN },
    generateNewUuid4
  );
}

/** Emit a short-lived marker run as a child of `parent`. */
async function emitMarker(
  parent: ReplaySafeRunTree,
  name: string,
  inputs: Record<string, unknown>
): Promise<ReplaySafeRunTree> {
  const marker = parent.createChild({ name, run_type: RUN_TYPE.CHAIN, inputs });
  await emitMarkerRun(marker);
  return marker;
}

function buildReplaySafeRunTree(
  config: WorkflowLangSmithConfig,
  params: {
    name: string;
    runType: string;
    parent: ReplaySafeRunTree | undefined;
    inputs: Record<string, unknown>;
    generateNewUuid4?: () => string;
  }
): ReplaySafeRunTree {
  return new ReplaySafeRunTree(
    {
      name: params.name,
      run_type: params.runType,
      parent_run: params.parent,
      project_name: config.projectName,
      tags: config.tags,
      extra: { metadata: scrubSensitive(config.metadata) ?? {} },
      inputs: params.inputs,
    },
    params.generateNewUuid4
  );
}

class LangSmithWorkflowInbound implements WorkflowInboundCallsInterceptor {
  constructor(private readonly config: WorkflowLangSmithConfig) {}

  async execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    const parent = reconstructParent(input.headers);
    return this.runInbound(
      runWorkflowRunName(workflowInfo().workflowType),
      RUN_TYPE.CHAIN,
      parent,
      { args: input.args },
      () => next(input)
    );
  }

  async handleSignal(input: SignalInput, next: Next<WorkflowInboundCallsInterceptor, 'handleSignal'>): Promise<void> {
    const parent = reconstructParent(input.headers);
    await this.runInbound(handleSignalRunName(input.signalName), RUN_TYPE.CHAIN, parent, { args: input.args }, () =>
      next(input)
    );
  }

  async handleQuery(input: QueryInput, next: Next<WorkflowInboundCallsInterceptor, 'handleQuery'>): Promise<unknown> {
    if (isInternalQuery(input.queryName)) {
      return next(input);
    }
    const parent = reconstructParent(input.headers);
    return this.runInbound(
      handleQueryRunName(input.queryName),
      RUN_TYPE.CHAIN,
      parent,
      { args: input.args },
      () => next(input),
      // Read-only: mint run ids from the nondeterministic unsafe random source so the
      // handler never draws from the Workflow main PRNG (which a clean replay would not advance).
      workflowInfo().unsafe.random.uuid4
    );
  }

  async handleUpdate(
    input: UpdateInput,
    next: Next<WorkflowInboundCallsInterceptor, 'handleUpdate'>
  ): Promise<unknown> {
    const parent = reconstructParent(input.headers);
    return this.runInbound(handleUpdateRunName(input.name), RUN_TYPE.CHAIN, parent, { args: input.args }, () =>
      next(input)
    );
  }

  validateUpdate(input: UpdateInput, next: Next<WorkflowInboundCallsInterceptor, 'validateUpdate'>): void {
    // Read-only: mint run ids from the nondeterministic unsafe random source so the validator
    // never draws from the Workflow main PRNG (which a clean replay would not advance).
    const generateNewUuid4 = workflowInfo().unsafe.random.uuid4;
    if (!this.config.addTemporalRuns) {
      // Propagation only: install the reconstructed parent (or a placeholder parent
      // when none was propagated, to keep a validator-body `traceable` off the
      // no-parent `crypto` path) so the validator body nests under the update's
      // trace.
      const ambient =
        asReplaySafeParent(reconstructParent(input.headers), generateNewUuid4) ?? placeholderRoot(generateNewUuid4);
      sharedStore.run(ambient, () => next(input));
      return;
    }
    const run = buildReplaySafeRunTree(this.config, {
      name: validateUpdateRunName(input.name),
      runType: RUN_TYPE.CHAIN,
      parent: asReplaySafeParent(reconstructParent(input.headers), generateNewUuid4),
      inputs: { args: input.args },
      generateNewUuid4,
    });
    // Validators are synchronous and must not be made async; emit start/end
    // around the synchronous call, with the run installed as the active store so
    // a `traceable` in the validator body nests under it.
    void run.postRun();
    try {
      sharedStore.run(run, () => next(input));
      void run.end({});
    } catch (err) {
      void run.end(undefined, describeError(err));
      void run.patchRun();
      throw err;
    }
    void run.patchRun();
  }

  /**
   * Open the inbound run, install it as the active run for the whole `next`
   * async scope, and close it. The real ALS scopes the run to this branch, so a
   * handler running concurrently with the workflow body never leaks its run into
   * the body's context.
   */
  private async runInbound(
    name: string,
    runType: string,
    parent: RunTree | undefined,
    inputs: Record<string, unknown>,
    next: () => Promise<unknown>,
    generateNewUuid4?: () => string
  ): Promise<unknown> {
    if (!this.config.addTemporalRuns) {
      // Propagation only: install the reconstructed parent as the active run so
      // user `traceable` runs nest under it; never emit a Temporal-operation run.
      // With no propagated parent, install a placeholder parent instead of
      // `undefined` so a workflow-body `traceable` takes LangSmith's
      // `createChild` branch (deterministic id) rather than the no-parent branch
      // that mints a uuid via `crypto`, which the isolate lacks.
      const ambient = asReplaySafeParent(parent, generateNewUuid4) ?? placeholderRoot(generateNewUuid4);
      return sharedStore.run(ambient, next);
    }
    const run = buildReplaySafeRunTree(this.config, {
      name,
      runType,
      parent: asReplaySafeParent(parent, generateNewUuid4),
      inputs,
      generateNewUuid4,
    });
    await run.postRun();
    const body = async (): Promise<unknown> => {
      try {
        const result = await next();
        await run.end(asOutputs(result));
        await run.patchRun();
        return result;
      } catch (err) {
        await run.end(undefined, describeError(err));
        await run.patchRun();
        throw err;
      }
    };
    return sharedStore.run(run, body);
  }
}

class LangSmithWorkflowOutbound implements WorkflowOutboundCallsInterceptor {
  constructor(private readonly config: WorkflowLangSmithConfig) {}

  async scheduleActivity(
    input: ActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleActivity'>
  ): Promise<unknown> {
    return this.peerMarker(startActivityRunName(input.activityType), input, (headers: Headers) =>
      next({ ...input, headers })
    );
  }

  async scheduleLocalActivity(
    input: LocalActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleLocalActivity'>
  ): Promise<unknown> {
    return this.peerMarker(startActivityRunName(input.activityType), input, (headers: Headers) =>
      next({ ...input, headers })
    );
  }

  async startChildWorkflowExecution(
    input: StartChildWorkflowExecutionInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'startChildWorkflowExecution'>
  ): Promise<[Promise<string>, Promise<unknown>]> {
    return this.peerMarker(startChildWorkflowRunName(input.workflowType), input, (headers: Headers) =>
      next({ ...input, headers })
    );
  }

  continueAsNew(
    input: ContinueAsNewInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'continueAsNew'>
  ): Promise<never> {
    // Don't propagate a placeholder root: it is never emitted, so the successor's
    // runs would dangle under a nonexistent parent. Let it install its own.
    const ambient = sharedStore.getStore();
    const context = ambient instanceof _RootReplaySafeRunTreeFactory ? undefined : runHeaders(ambient);
    const headers = withContextHeader(input.headers, context);
    return next({ ...input, headers });
  }

  async signalWorkflow(
    input: SignalWorkflowInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'signalWorkflow'>
  ): Promise<void> {
    const isChild = input.target.type === 'child';
    const name = isChild
      ? signalChildWorkflowRunName(input.signalName)
      : signalExternalWorkflowRunName(input.signalName);
    return this.parentMarker(name, input, (headers: Headers) => next({ ...input, headers }));
  }

  async startNexusOperation(
    input: StartNexusOperationInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'startNexusOperation'>
  ): Promise<StartNexusOperationOutput> {
    const ambient = sharedStore.getStore();
    if (this.config.addTemporalRuns && ambient instanceof ReplaySafeRunTree) {
      await emitMarker(ambient, startNexusOperationRunName(input.service, input.operation), {});
    }
    const ctx = runHeaders(ambient);
    const headers = ctx ? { ...input.headers, [HEADER_KEY]: encodeContextString(ctx) } : input.headers;
    return next({ ...input, headers });
  }

  /** Sibling-marker operations: marker is a peer of the remote run; propagate ambient. */
  private async peerMarker<R>(
    name: string,
    input: { headers: Headers; args?: unknown[] },
    next: (headers: Headers) => Promise<R>
  ): Promise<R> {
    const ambient = sharedStore.getStore();
    if (this.config.addTemporalRuns && ambient instanceof ReplaySafeRunTree) {
      await emitMarker(ambient, name, { args: input.args ?? [] });
    }
    const headers = withContextHeader(input.headers, runHeaders(ambient));
    return next(headers);
  }

  /** Parent-marker operations: remote handler nests under the marker; propagate marker. */
  private async parentMarker<R>(
    name: string,
    input: { headers: Headers; args?: unknown[] },
    next: (headers: Headers) => Promise<R>
  ): Promise<R> {
    const ambient = sharedStore.getStore();
    let propagate: RunTree | undefined = ambient;
    if (this.config.addTemporalRuns && ambient instanceof ReplaySafeRunTree) {
      propagate = await emitMarker(ambient, name, { args: input.args ?? [] });
    }
    const headers = withContextHeader(input.headers, runHeaders(propagate));
    return next(headers);
  }
}

/**
 * Workflow interceptors factory. Loaded by the Temporal worker for every
 * workflow in the bundle (registered via the plugin's `workflowModules`).
 *
 * @internal
 */
export function interceptors(): WorkflowInterceptors {
  const config = readConfig();
  return {
    inbound: [new LangSmithWorkflowInbound(config)],
    outbound: [new LangSmithWorkflowOutbound(config)],
  };
}
