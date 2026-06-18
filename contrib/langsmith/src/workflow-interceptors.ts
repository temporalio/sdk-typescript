/**
 * Workflow-isolate interceptors and the deterministic LangSmith context
 * provider. Loaded into the workflow bundle (via the plugin's `workflowModules`)
 * and runs entirely inside the V8 isolate, where `node:async_hooks` is
 * unavailable so a synchronous stack-based context provider stands in for
 * LangSmith's async-context store.
 *
 * Internal: the worker loads this module by specifier and the bundler aliases
 * `node:async_hooks` to it — it is not a hand-import API.
 *
 * @module
 * @internal
 */

import { RunTree } from 'langsmith/run_trees';
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
import { getActivator } from '@temporalio/workflow/lib/global-attributes';

import { prngFromInputId } from './prng';
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

// Temporal Core hard-codes queryId === 'legacy_query' on the legacy single-Query
// Workflow Task path. Each legacy Query rides its own Task, so queryName plus the
// per-Task wall-clock distinguishes them across their separate Tasks.
// The `getTimeOfDay()` non-determinism is intentional and inconsequential: read-only
// query handlers never advance the main Workflow PRNG and never emit on replay.
function resolveQueryKey(input: QueryInput): string {
  return input.queryId !== 'legacy_query' ? input.queryId : `${input.queryName}:${getActivator().getTimeOfDay()}`;
}

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

/**
 * Synchronous, isolate-safe replacement for LangSmith's async-context store,
 * shared by the installed provider, the {@link AsyncLocalStorage} shim, and
 * every interceptor so they all read and write one store. `workflowAmbient`
 * persists across `await` boundaries; `stack` tracks synchronous `traceable`
 * nesting. Under `Promise.all` fan-out parenting falls back to the ambient —
 * trace-shape-only non-determinism, never workflow history.
 */
class WorkflowContextManager {
  private workflowAmbient: RunTree | undefined;
  private readonly stack: (RunTree | undefined)[] = [];

  getStore(): RunTree | undefined {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : this.workflowAmbient;
  }

  /**
   * Push `context`, run `fn`, pop in `finally`, and return `fn`'s result — the
   * `AsyncLocalStorage.run` contract langsmith relies on.
   */
  run<T>(context: RunTree | undefined, fn: () => T): T {
    this.stack.push(context);
    try {
      return fn();
    } finally {
      this.stack.pop();
    }
  }

  /** The ambient run an outbound interceptor should propagate / parent under. */
  ambient(): RunTree | undefined {
    return this.getStore();
  }

  /** Run an async scope with a dedicated ambient (workflow execute / handler). */
  async withAmbient<T>(run: RunTree | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = this.workflowAmbient;
    this.workflowAmbient = run;
    try {
      return await fn();
    } finally {
      this.workflowAmbient = prev;
    }
  }
}

let providerInstalled = false;
function ensureProviderInstalled(manager: WorkflowContextManager): void {
  if (providerInstalled) {
    return;
  }
  providerInstalled = true;
  // LangSmith's `AsyncLocalStorageInterface` requires exactly two members,
  // `getStore` and `run` (it never calls `enterWith`), so we provide only those.
  // The cast bridges the generic `run<T>` signature to the interface's
  // `run: (ctx, () => void) => void`.
  AsyncLocalStorageProviderSingleton.initializeGlobalInstance({
    getStore: () => manager.getStore(),
    run: <T>(context: RunTree | undefined, fn: () => T): T => manager.run(context as RunTree | undefined, fn),
  } as Parameters<typeof AsyncLocalStorageProviderSingleton.initializeGlobalInstance>[0]);
}

const sharedManager = new WorkflowContextManager();
ensureProviderInstalled(sharedManager);

/**
 * Isolate-safe stand-in for Node's `AsyncLocalStorage`. The plugin's bundler
 * aliases `node:async_hooks` (absent in the isolate) to this module so
 * LangSmith's `import { AsyncLocalStorage } from "node:async_hooks"` resolves
 * here. Every instance delegates to {@link sharedManager}.
 *
 * @internal
 */
export class AsyncLocalStorage<T = unknown> {
  getStore(): T | undefined {
    return sharedManager.getStore() as unknown as T | undefined;
  }

  run<R>(store: T, fn: (...args: never[]) => R): R {
    return sharedManager.run(store as unknown as RunTree | undefined, fn as () => R);
  }

  enterWith(_store: T): void {
    /* no-op: parenting inside the isolate is stack-scoped via run() */
  }

  /**
   * Best-effort equivalent of `AsyncLocalStorage.snapshot()` (used only by
   * LangSmith's async-generator streaming paths). Runs the callback in the
   * current synchronous scope; the isolate has no async context to capture.
   */
  static snapshot(): (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => unknown {
    return (fn, ...args) => fn(...args);
  }
}

/** Reconstruct the propagated parent run from a Payload-keyed header map. */
function reconstructParent(headers: Record<string, unknown> | undefined): RunTree | undefined {
  return runTreeFromContext(readContextHeader(headers as Record<string, never> | undefined));
}

/**
 * Re-wrap a reconstructed (plain) parent so its `createChild` produces
 * replay-safe children. Carries the same id/trace/dotted so descendants parent
 * under the real propagated run; never emitted itself.
 */
function asReplaySafeParent(parent: RunTree | undefined, random?: () => number): ReplaySafeRunTree | undefined {
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
    random
  );
}

/**
 * A placeholder parent for the no-propagated-parent case. Installed as the ambient
 * so a workflow-body `traceable` always nests via `createChild`; never emitted,
 * and its children are independent roots (see {@link _RootReplaySafeRunTreeFactory}).
 */
function placeholderRoot(random?: () => number): _RootReplaySafeRunTreeFactory {
  return new _RootReplaySafeRunTreeFactory({ name: workflowInfo().workflowType, run_type: RUN_TYPE.CHAIN }, random);
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
    random?: () => number;
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
    params.random
  );
}

class LangSmithWorkflowInbound implements WorkflowInboundCallsInterceptor {
  constructor(
    private readonly ctx: WorkflowContextManager,
    private readonly config: WorkflowLangSmithConfig
  ) {}

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
    await this.runInbound(
      handleSignalRunName(input.signalName),
      RUN_TYPE.CHAIN,
      parent,
      { args: input.args },
      () => next(input),
      true
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
      true,
      // Read-only: seed run-id minting from a per-call PRNG so the handler never
      // draws from the Workflow main PRNG (which a clean replay would not advance).
      prngFromInputId(resolveQueryKey(input))
    );
  }

  async handleUpdate(
    input: UpdateInput,
    next: Next<WorkflowInboundCallsInterceptor, 'handleUpdate'>
  ): Promise<unknown> {
    const parent = reconstructParent(input.headers);
    return this.runInbound(
      handleUpdateRunName(input.name),
      RUN_TYPE.CHAIN,
      parent,
      { args: input.args },
      () => next(input),
      true
    );
  }

  validateUpdate(input: UpdateInput, next: Next<WorkflowInboundCallsInterceptor, 'validateUpdate'>): void {
    // Read-only: seed run-id minting from a per-call PRNG so the validator never
    // draws from the Workflow main PRNG (which a clean replay would not advance).
    const random = prngFromInputId(input.updateId);
    if (!this.config.addTemporalRuns) {
      // Propagation only: install the reconstructed parent (or a placeholder parent
      // when none was propagated, to keep a validator-body `traceable` off the
      // no-parent `crypto` path) so the validator body nests under the update's
      // trace. Validators are synchronous, so install via the stack-based `run`,
      // not the async `withAmbient`.
      const ambient = asReplaySafeParent(reconstructParent(input.headers), random) ?? placeholderRoot(random);
      this.ctx.run(ambient, () => next(input));
      return;
    }
    const run = buildReplaySafeRunTree(this.config, {
      name: validateUpdateRunName(input.name),
      runType: RUN_TYPE.CHAIN,
      parent: asReplaySafeParent(reconstructParent(input.headers), random),
      inputs: { args: input.args },
      random,
    });
    // Validators are synchronous and must not be made async; emit start/end
    // around the synchronous call, with the run installed on the stack so a
    // `traceable` in the validator body nests under it.
    void run.postRun();
    try {
      this.ctx.run(run, () => next(input));
      void run.end({});
    } catch (err) {
      void run.end(undefined, describeError(err));
      void run.patchRun();
      throw err;
    }
    void run.patchRun();
  }

  /**
   * Open the inbound run, install it as the active run for `next`, and close it.
   *
   * `scoped` handlers install the run on the synchronous stack so a handler running
   * concurrently with the workflow body cannot leak its run into the body's ambient;
   * `execute` (scoped: false) installs a persistent ambient that survives the body's
   * awaits.
   */
  private async runInbound(
    name: string,
    runType: string,
    parent: RunTree | undefined,
    inputs: Record<string, unknown>,
    next: () => Promise<unknown>,
    scoped = false,
    random?: () => number
  ): Promise<unknown> {
    if (!this.config.addTemporalRuns) {
      // Propagation only: install the reconstructed parent as the active run so
      // user `traceable` runs nest under it; never emit a Temporal-operation run.
      // With no propagated parent, install a placeholder parent instead of
      // `undefined` so a workflow-body `traceable` takes LangSmith's
      // `createChild` branch (deterministic id) rather than the no-parent branch
      // that mints a uuid via `crypto`, which the isolate lacks.
      const ambient = asReplaySafeParent(parent, random) ?? placeholderRoot(random);
      return scoped ? this.ctx.run(ambient, next) : this.ctx.withAmbient(ambient, next);
    }
    const run = buildReplaySafeRunTree(this.config, {
      name,
      runType,
      parent: asReplaySafeParent(parent, random),
      inputs,
      random,
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
    return scoped ? this.ctx.run(run, body) : this.ctx.withAmbient(run, body);
  }
}

class LangSmithWorkflowOutbound implements WorkflowOutboundCallsInterceptor {
  constructor(
    private readonly ctx: WorkflowContextManager,
    private readonly config: WorkflowLangSmithConfig
  ) {}

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
    const ambient = this.ctx.ambient();
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
    const ambient = this.ctx.ambient();
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
    const ambient = this.ctx.ambient();
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
    const ambient = this.ctx.ambient();
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
    inbound: [new LangSmithWorkflowInbound(sharedManager, config)],
    outbound: [new LangSmithWorkflowOutbound(sharedManager, config)],
  };
}
