/**
 * Workflow-isolate interceptors and the deterministic LangSmith context
 * provider. This module is loaded into the workflow bundle (via the plugin's
 * `workflowModules`) and runs entirely inside the V8 isolate.
 *
 * Responsibilities:
 *  - Install a workflow-safe replacement for LangSmith's async-context store.
 *    Inside the isolate `node:async_hooks` is unavailable, so LangSmith's
 *    default provider degrades to a mock whose `getStore()` is always
 *    `undefined` and native `traceable` cannot find its parent. We install a
 *    synchronous stack-based provider so `traceable` nests correctly.
 *  - Inbound: open a `RunWorkflow:` / `Handle*:` span (when `addTemporalRuns`)
 *    parented under the propagated trace, install it as the ambient run, and
 *    close it when the call returns.
 *  - Outbound: emit the peer/parent marker run and inject the trace header so
 *    the downstream operation nests correctly.
 *
 * @module
 */

import {
  ContinueAsNewInput,
  Next,
  workflowInfo,
  WorkflowExecuteInput,
  WorkflowInboundCallsInterceptor,
  WorkflowInterceptors,
  WorkflowOutboundCallsInterceptor,
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
import { RunTree } from 'langsmith/run_trees';
import { AsyncLocalStorageProviderSingleton } from 'langsmith/singletons/traceable';

import {
  HEADER_KEY,
  encodeContextString,
  isInternalQuery,
  readContextHeader,
  withContextHeader,
  type LangSmithTraceContext,
} from './propagation';
import {
  ReplaySafeRunTree,
  RUN_TYPE,
  continueAsNewRunName,
  describeError,
  handleQueryRunName,
  handleSignalRunName,
  handleUpdateRunName,
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
 */
export interface WorkflowLangSmithConfig {
  addTemporalRuns: boolean;
  projectName?: string;
  defaultTags?: string[];
  defaultMetadata?: Record<string, unknown>;
}

// Injected at bundle time by the plugin's DefinePlugin. Declared so the bare
// identifier is replaced textually (avoids the dotted-access DefinePlugin
// footgun). Absent in environments that bundled without the plugin.
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
 * Synchronous, isolate-safe replacement for LangSmith's async-context store.
 *
 * Two layers:
 *  - `workflowAmbient` persists across `await` boundaries for the lifetime of
 *    the workflow / handler call (so outbound interceptors and post-await
 *    `traceable` calls find a parent).
 *  - `stack` tracks synchronous `traceable` nesting via save/restore around
 *    `run()`. Because LangSmith fixes a child's parent at the synchronous
 *    moment the wrapped function is invoked (not when it later awaits), the
 *    common `return await inner(...)` pattern nests correctly.
 *
 * Best-effort caveat: under `Promise.all` fan-out or `traceable` calls made
 * *after* an `await` in the same scope, parenting falls back to the workflow
 * ambient. This is permissible non-determinism — it never affects workflow
 * history or control flow, only the trace shape — and is documented in the
 * README.
 */
class WorkflowContextManager {
  private workflowAmbient: RunTree | undefined;
  private readonly stack: (RunTree | undefined)[] = [];

  getStore(): RunTree | undefined {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : this.workflowAmbient;
  }

  /**
   * Push `context`, run `fn`, pop in `finally`, and **return `fn`'s result**.
   *
   * Returning the result is the `AsyncLocalStorage.run` contract that LangSmith
   * relies on: `traceable` wraps the user function as
   * `provider.run(child, () => fn(...args))` and returns that value, so a `run`
   * that returned `void` would make every traceable-wrapped function resolve to
   * `undefined` inside a workflow. For an async `fn`, the returned promise is
   * captured synchronously (before the `finally` pops the stack), which is why
   * the synchronous prefix nests correctly while post-`await` work falls back to
   * the workflow ambient.
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
  // `traceable` resolves its parent via `getStore()` and pushes the child run for
  // the duration of the wrapped call via `run(child, fn)`; both are exercised by
  // a workflow-body `traceable` (see comprehensive.test.ts). The cast bridges the
  // generic `run<T>` signature to the interface's `run: (ctx, () => void) => void`.
  AsyncLocalStorageProviderSingleton.initializeGlobalInstance({
    getStore: () => manager.getStore(),
    run: <T>(context: RunTree | undefined, fn: () => T): T =>
      manager.run(context as RunTree | undefined, fn),
  } as Parameters<typeof AsyncLocalStorageProviderSingleton.initializeGlobalInstance>[0]);
}

/**
 * Module-level singleton context manager. One instance is shared by the
 * installed LangSmith provider, the {@link AsyncLocalStorage} shim below, and
 * every workflow inbound/outbound interceptor created by {@link interceptors}.
 * Sharing matters: the global LangSmith provider is installed exactly once (the
 * SDK's `initializeGlobalInstance` is first-install-wins), so a *per-call*
 * manager would desync from that provider on the second workflow execution in a
 * reused isolate context — `getCurrentRunTree()` would read a stale manager and
 * a workflow-body `traceable` would fail to nest. A single shared manager keeps
 * the provider's `getStore()` and the interceptors' `withAmbient()` in lockstep.
 */
const sharedManager = new WorkflowContextManager();
ensureProviderInstalled(sharedManager);

/**
 * Isolate-safe stand-in for Node's `AsyncLocalStorage`. The plugin's bundler
 * aliases `node:async_hooks` (which does not exist in the V8 isolate) to this
 * module, so a user workflow body that imports `langsmith/traceable` resolves
 * LangSmith's `import { AsyncLocalStorage } from "node:async_hooks"` — and the
 * `new AsyncLocalStorage()` it constructs at module load — to this class instead
 * of failing the webpack build.
 *
 * Every instance delegates to {@link sharedManager}. This makes the
 * first-install-wins race between LangSmith (which calls
 * `initializeGlobalInstance(new AsyncLocalStorage())` at its module load) and
 * the plugin (which calls `ensureProviderInstalled` above) irrelevant: whichever
 * runs first, the registered provider is backed by the same deterministic store.
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
  const ctx = readContextHeader(headers as Record<string, never> | undefined);
  if (!ctx) {
    return undefined;
  }
  try {
    return RunTree.fromHeaders(ctx as unknown as Record<string, string>) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-wrap a reconstructed (plain) parent so its `createChild` produces
 * replay-safe children. Carries the same id/trace/dotted so descendants parent
 * under the real propagated run; never emitted itself.
 */
function asReplaySafeAnchor(parent: RunTree | undefined): ReplaySafeRunTree | undefined {
  if (!parent) {
    return undefined;
  }
  return new ReplaySafeRunTree({
    name: parent.name,
    run_type: parent.run_type,
    id: parent.id,
    trace_id: parent.trace_id,
    dotted_order: parent.dotted_order,
    parent_run_id: parent.parent_run_id,
    project_name: parent.project_name,
  });
}

function contextHeaderObject(run: RunTree | undefined): LangSmithTraceContext | undefined {
  return run ? (run.toHeaders() as LangSmithTraceContext) : undefined;
}

/** Emit a short-lived marker run (post + patch) as a child of `parent`. */
async function emitMarker(
  parent: ReplaySafeRunTree,
  name: string,
  inputs: Record<string, unknown>,
): Promise<ReplaySafeRunTree> {
  const marker = parent.createChild({ name, run_type: RUN_TYPE.CHAIN, inputs });
  await marker.postRun();
  await marker.end({});
  await marker.patchRun();
  return marker;
}

class LangSmithWorkflowInbound implements WorkflowInboundCallsInterceptor {
  constructor(
    private readonly ctx: WorkflowContextManager,
    private readonly config: WorkflowLangSmithConfig,
  ) {}

  async execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    const parent = reconstructParent(input.headers);
    return this.runInbound(
      runWorkflowRunName(workflowInfo().workflowType),
      RUN_TYPE.CHAIN,
      parent,
      { args: input.args },
      () => next(input),
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
    );
  }

  async handleUpdate(input: UpdateInput, next: Next<WorkflowInboundCallsInterceptor, 'handleUpdate'>): Promise<unknown> {
    const parent = reconstructParent(input.headers);
    return this.runInbound(
      handleUpdateRunName(updateName(input)),
      RUN_TYPE.CHAIN,
      parent,
      { args: input.args },
      () => next(input),
    );
  }

  validateUpdate(input: UpdateInput, next: Next<WorkflowInboundCallsInterceptor, 'validateUpdate'>): void {
    if (!this.config.addTemporalRuns) {
      next(input);
      return;
    }
    const parent = reconstructParent(input.headers);
    const anchor = asReplaySafeAnchor(parent);
    const run = new ReplaySafeRunTree({
      name: validateUpdateRunName(updateName(input)),
      run_type: RUN_TYPE.CHAIN,
      parent_run: anchor,
      project_name: this.config.projectName,
      tags: this.config.defaultTags,
      extra: { metadata: this.config.defaultMetadata },
      inputs: { args: input.args },
    });
    // Validators are synchronous and must not be made async; emit start/end
    // around the synchronous call.
    void run.postRun();
    try {
      next(input);
      void run.end({});
    } catch (err) {
      void run.end(undefined, describeError(err));
      void run.patchRun();
      throw err;
    }
    void run.patchRun();
  }

  private async runInbound(
    name: string,
    runType: string,
    parent: RunTree | undefined,
    inputs: Record<string, unknown>,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    if (!this.config.addTemporalRuns) {
      // Propagation only: install the reconstructed parent as ambient so user
      // `traceable` runs nest under it; never emit a Temporal-operation run.
      return this.ctx.withAmbient(asReplaySafeAnchor(parent), next);
    }
    const anchor = asReplaySafeAnchor(parent);
    const run = new ReplaySafeRunTree({
      name,
      run_type: runType,
      parent_run: anchor,
      project_name: this.config.projectName,
      tags: this.config.defaultTags,
      extra: { metadata: this.config.defaultMetadata },
      inputs,
    });
    await run.postRun();
    return this.ctx.withAmbient(run, async () => {
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
    });
  }
}

class LangSmithWorkflowOutbound implements WorkflowOutboundCallsInterceptor {
  constructor(
    private readonly ctx: WorkflowContextManager,
    private readonly config: WorkflowLangSmithConfig,
  ) {}

  async scheduleActivity(
    input: ActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleActivity'>,
  ): Promise<unknown> {
    return this.peerMarker(startActivityRunName(input.activityType), input, (headers: Headers) =>
      next({ ...input, headers }),
    );
  }

  async scheduleLocalActivity(
    input: LocalActivityInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'scheduleLocalActivity'>,
  ): Promise<unknown> {
    return this.peerMarker(startActivityRunName(input.activityType), input, (headers: Headers) =>
      next({ ...input, headers }),
    );
  }

  async startChildWorkflowExecution(
    input: StartChildWorkflowExecutionInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'startChildWorkflowExecution'>,
  ): Promise<[Promise<string>, Promise<unknown>]> {
    return this.peerMarker(
      startChildWorkflowRunName(input.workflowType),
      input,
      (headers: Headers) => next({ ...input, headers }),
    );
  }

  async continueAsNew(
    input: ContinueAsNewInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'continueAsNew'>,
  ): Promise<never> {
    const ambient = this.ctx.ambient();
    if (this.config.addTemporalRuns && ambient instanceof ReplaySafeRunTree) {
      await emitMarker(ambient, continueAsNewRunName(workflowInfo().workflowType), { args: input.args });
    }
    const headers = withContextHeader(input.headers, contextHeaderObject(ambient));
    return next({ ...input, headers });
  }

  async signalWorkflow(
    input: SignalWorkflowInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'signalWorkflow'>,
  ): Promise<void> {
    const isChild = input.target.type === 'child';
    const name = isChild
      ? signalChildWorkflowRunName(input.signalName)
      : signalExternalWorkflowRunName(input.signalName);
    return this.parentMarker(name, input, (headers: Headers) => next({ ...input, headers }));
  }

  async startNexusOperation(
    input: StartNexusOperationInput,
    next: Next<WorkflowOutboundCallsInterceptor, 'startNexusOperation'>,
  ): Promise<StartNexusOperationOutput> {
    const ambient = this.ctx.ambient();
    if (this.config.addTemporalRuns && ambient instanceof ReplaySafeRunTree) {
      await emitMarker(ambient, startNexusOperationRunName(input.service, input.operation), {});
    }
    const ctx = contextHeaderObject(ambient);
    const headers = ctx
      ? { ...input.headers, [HEADER_KEY]: encodeContextString(ctx) }
      : input.headers;
    return next({ ...input, headers });
  }

  /** Sibling-marker operations: marker is a peer of the remote run; propagate ambient. */
  private async peerMarker<R>(
    name: string,
    input: { headers: Headers; args?: unknown[] },
    next: (headers: Headers) => Promise<R>,
  ): Promise<R> {
    const ambient = this.ctx.ambient();
    if (this.config.addTemporalRuns && ambient instanceof ReplaySafeRunTree) {
      await emitMarker(ambient, name, { args: input.args ?? [] });
    }
    const headers = withContextHeader(input.headers, contextHeaderObject(ambient));
    return next(headers);
  }

  /** Parent-marker operations: remote handler nests under the marker; propagate marker. */
  private async parentMarker<R>(
    name: string,
    input: { headers: Headers; args?: unknown[] },
    next: (headers: Headers) => Promise<R>,
  ): Promise<R> {
    const ambient = this.ctx.ambient();
    let propagate: RunTree | undefined = ambient;
    if (this.config.addTemporalRuns && ambient instanceof ReplaySafeRunTree) {
      const marker = ambient.createChild({ name, run_type: RUN_TYPE.CHAIN, inputs: { args: input.args ?? [] } });
      await marker.postRun();
      propagate = marker;
    }
    const headers = withContextHeader(input.headers, contextHeaderObject(propagate));
    return next(headers);
  }
}

/**
 * Resolve the update name from the SDK's {@link UpdateInput}. The SDK guarantees
 * `name` is always present, so no fallback is needed.
 */
function updateName(input: UpdateInput): string {
  return input.name;
}

function asOutputs(result: unknown): Record<string, unknown> {
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { result };
}

/**
 * Workflow interceptors factory. Loaded by the Temporal worker for every
 * workflow in the bundle (registered via the plugin's `workflowModules`).
 */
export function interceptors(): WorkflowInterceptors {
  // Reuse the module-level {@link sharedManager} (installed as the LangSmith
  // provider at module load) so the provider's `getStore()` and these
  // interceptors' `withAmbient()` operate on the same store.
  const config = readConfig();
  return {
    inbound: [new LangSmithWorkflowInbound(sharedManager, config)],
    outbound: [new LangSmithWorkflowOutbound(sharedManager, config)],
  };
}
