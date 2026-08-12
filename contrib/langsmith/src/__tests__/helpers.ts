/**
 * Shared test harness: {@link InMemoryRunCollector} captures every run the plugin
 * emits, and {@link dumpTraces} renders them as an indented tree for assertions.
 *
 * @module
 */

import { randomUUID } from 'crypto';
import type { TestFn } from 'ava';
import type { Client as LangSmithClient } from 'langsmith';
import { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode, type WorkerOptions, type WorkflowBundle } from '@temporalio/worker';

import { LangSmithPlugin, type LangSmithPluginOptions } from '../index';

/** Absolute path to the test workflow bundle (resolved from this module). */
export const WORKFLOWS_PATH = require.resolve('./workflows/langsmith');

/** Expected tree for `SimpleWorkflow` with `addTemporalRuns: true`: one workflow run and its single activity. */
export const SIMPLE_TREE = [
  'StartWorkflow:SimpleWorkflow',
  'RunWorkflow:SimpleWorkflow',
  '  StartActivity:simpleActivity',
  '  RunActivity:simpleActivity',
].join('\n');

/** A run as captured by {@link InMemoryRunCollector}; superset of create/update fields. */
export interface CollectedRun {
  id: string;
  name: string;
  run_type?: string;
  parent_run_id?: string;
  trace_id?: string;
  dotted_order?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  end_time?: number | string;
  error?: string | null;
  tags?: string[];
  extra?: Record<string, unknown>;
  project_name?: string;
  events?: unknown[];
}

/** In-memory stand-in for a LangSmith `Client`; records `createRun`s in order and merges `updateRun`s by id. */
export class InMemoryRunCollector {
  /** Run ids in first-seen (createRun) order. */
  readonly createOrder: string[] = [];
  /** Latest merged state per run id. */
  readonly byId = new Map<string, CollectedRun>();
  /** Set by the flush hook test; counts flush invocations. */
  flushCount = 0;

  createRun = async (run: Record<string, unknown>): Promise<void> => {
    const id = String(run.id);
    if (!this.byId.has(id)) {
      this.createOrder.push(id);
      this.byId.set(id, { id, name: String(run.name) });
    }
    this.byId.set(id, { ...this.byId.get(id)!, ...(run as Partial<CollectedRun>), id });
  };

  updateRun = async (id: string, update: Record<string, unknown>): Promise<void> => {
    const existing = this.byId.get(id);
    if (existing) {
      this.byId.set(id, { ...existing, ...(update as Partial<CollectedRun>), id });
    }
  };

  /** Flush hook used by the plugin's shutdown path; recorded for assertions. */
  awaitPendingTraceBatches = async (): Promise<void> => {
    this.flushCount += 1;
  };

  /** Collected runs in createRun order. */
  get records(): CollectedRun[] {
    return this.createOrder.map((id) => this.byId.get(id)!);
  }

  /** First run with the given display name, if any. */
  byName(name: string): CollectedRun | undefined {
    for (const id of this.createOrder) {
      const run = this.byId.get(id)!;
      if (run.name === name) {
        return run;
      }
    }
    return undefined;
  }

  /** The display name of a run's parent, or undefined for a root / unknown parent. */
  parentNameOf(name: string): string | undefined {
    const run = this.byName(name);
    if (!run?.parent_run_id) {
      return undefined;
    }
    return this.byId.get(run.parent_run_id)?.name;
  }

  /** Reset between sub-cases that share a process. */
  clear(): void {
    this.createOrder.length = 0;
    this.byId.clear();
    this.flushCount = 0;
  }

  /** Copy of the current state; lets the harness roll back a retried attempt. */
  snapshot(): { createOrder: string[]; byId: Map<string, CollectedRun>; flushCount: number } {
    return { createOrder: [...this.createOrder], byId: new Map(this.byId), flushCount: this.flushCount };
  }

  /** Restore a {@link snapshot}, discarding anything recorded since. */
  restore(state: { createOrder: string[]; byId: Map<string, CollectedRun>; flushCount: number }): void {
    this.createOrder.length = 0;
    this.createOrder.push(...state.createOrder);
    this.byId.clear();
    for (const [id, run] of state.byId) {
      this.byId.set(id, run);
    }
    this.flushCount = state.flushCount;
  }

  /** View this collector as a LangSmith client for the plugin's `client` option. */
  asClient(): LangSmithClient {
    return this as unknown as LangSmithClient;
  }
}

/** Render collected runs as an indented tree grouped by `parent_run_id`, throwing on a dangling parent. */
export function dumpTraces(records: CollectedRun[]): string {
  const byId = new Map<string, CollectedRun>();
  const order: string[] = [];
  for (const r of records) {
    if (!byId.has(r.id)) {
      byId.set(r.id, r);
      order.push(r.id);
    }
  }

  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of order) {
    const rec = byId.get(id)!;
    const parent = rec.parent_run_id;
    if (parent == null) {
      roots.push(id);
    } else if (byId.has(parent)) {
      const arr = children.get(parent);
      if (arr) {
        arr.push(id);
      } else {
        children.set(parent, [id]);
      }
    } else {
      throw new Error(`dangling parent_run_id=${parent} for run "${rec.name}" (${id})`);
    }
  }

  const lines: string[] = [];
  const walk = (id: string, depth: number): void => {
    lines.push('  '.repeat(depth) + byId.get(id)!.name);
    for (const child of children.get(id) ?? []) {
      walk(child, depth + 1);
    }
  };
  for (const root of roots) {
    walk(root, 0);
  }
  return lines.join('\n');
}

/** Options for {@link withTracingWorker}. */
export interface HarnessArgs<T> {
  /** Collector to use as the plugin's LangSmith client. */
  collector: InMemoryRunCollector;
  /** Plugin options other than `client` (which is the collector). */
  options?: Omit<LangSmithPluginOptions, 'client'>;
  /** Activity implementations to register on the worker. */
  activities: Record<string, (...args: never[]) => unknown>;
  /** Task queue (defaults to a fixed value). */
  taskQueue?: string;
  /** Extra worker options (e.g. `maxCachedWorkflows`). */
  workerOptions?: Partial<WorkerOptions>;
  /** Body run with a plugin-enabled client + worker live. */
  body: (ctx: { client: Client; taskQueue: string; env: TestWorkflowEnvironment }) => Promise<T>;
}

// One local Temporal server shared by all cases in a file
let sharedEnv: TestWorkflowEnvironment | undefined;

/** Register a per-file shared `TestWorkflowEnvironment`; `withTracingWorker` will reuse it. */
export function useSharedEnv(test: TestFn<unknown>): void {
  test.before(async () => {
    sharedEnv = await TestWorkflowEnvironment.createLocal();
  });
  test.after.always(async () => {
    await sharedEnv?.teardown();
    sharedEnv = undefined;
  });
}

const bundleCache = new Map<string, Promise<WorkflowBundle>>();

function getBundle(plugin: LangSmithPlugin, workflowsPath: string, optionsKey: string): Promise<WorkflowBundle> {
  const key = `${workflowsPath}\n${optionsKey}`;
  let bundle = bundleCache.get(key);
  if (!bundle) {
    // Route through the plugin so the bundle carries its workflow interceptor
    // module + baked config, exactly as Worker.create would have built it.
    bundle = bundleWorkflowCode(plugin.configureBundler({ workflowsPath }));
    bundleCache.set(key, bundle);
  }
  return bundle;
}

// Bound on one body attempt, and how many fresh workers to try. On a loaded CI
// machine the dev server + worker pair can permanently fail to deliver a
// workflow's *first* workflow task: the task stays SCHEDULED at attempt 1
// forever (normal-queue first tasks have no schedule-to-start timeout), while a
// fresh poller on the same queue receives it instantly. Left alone, the case
// promise never settles, AVA's 120s inactivity watchdog fires, and its SIGTERM
// is swallowed by the SDK Runtime's shutdown handler — wedging the whole suite
// until the CI job timeout. Bounding each attempt and retrying on a fresh
// worker + task queue converts that hang into (at worst) a visible failure and
// (in practice) a recovered pass.
//
// Calibration (from CI run 31544937973, linux-arm Node 24 leg):
//  - 30s per attempt is latency headroom, not the recovery lever. Even on the
//    slowest, contended runners a fresh worker reaches RUNNING in <300ms and
//    healthy bodies finish in single-digit seconds; stalled attempts show zero
//    activity for the entire window, and an unmitigated stall never recovers
//    (20+ minute hung jobs). Waiting longer per attempt therefore cannot help;
//    only a fresh worker can.
//  - Stalls are correlated in time: that leg saw one case stall on 2/3
//    attempts then recover, and another stall on 3/3 back-to-back attempts
//    (~90s window). Six attempts sample a ~3 minute window — double the worst
//    observed sequence — while still failing loudly within minutes if the
//    degradation persists.
//  - Attempts are not capped by AVA's 120s inactivity watchdog: AVA debounces
//    that timer on every stateChange record carrying a testFile, which
//    includes worker-stdout/stderr chunks (ava 5.3.1 lib/fork.js tags all
//    records with testFile; lib/api.js debounces on any of them). The retry
//    warning below is therefore load-bearing: it guarantees output every
//    ≤~30s while attempts continue, so the watchdog only fires for a genuine
//    silent wedge (its backstop role, unchanged).
const BODY_STALL_TIMEOUT_MS = 30_000;
const MAX_BODY_ATTEMPTS = 6;

/** A body attempt exceeded {@link BODY_STALL_TIMEOUT_MS}; the harness retries on a fresh worker. */
class HarnessStallError extends Error {
  constructor(taskQueue: string, attempt: number) {
    super(
      `Test body did not settle within ${BODY_STALL_TIMEOUT_MS}ms on task queue ${taskQueue} ` +
        `(attempt ${attempt}/${MAX_BODY_ATTEMPTS}); assuming the first-workflow-task delivery stall`
    );
  }
}

/** Terminate workflows a stalled attempt left running so a retry can reuse their workflow ids. */
async function terminateLeakedWorkflows(env: TestWorkflowEnvironment, taskQueue: string): Promise<void> {
  try {
    const leaked = env.client.workflow.list({
      query: `TaskQueue = '${taskQueue}' AND ExecutionStatus = 'Running'`,
    });
    for await (const wf of leaked) {
      try {
        await env.client.workflow.getHandle(wf.workflowId, wf.runId).terminate('stalled harness attempt cleanup');
      } catch {
        /* already closed */
      }
    }
  } catch {
    /* best-effort: the retry runs on a fresh task queue regardless */
  }
}

export async function withTracingWorker<T>(args: HarnessArgs<T>): Promise<T> {
  const privateEnv = sharedEnv ? undefined : await TestWorkflowEnvironment.createLocal();
  const env = sharedEnv ?? privateEnv!;
  try {
    const plugin = new LangSmithPlugin({ ...args.options, client: args.collector.asClient() });

    const { workflowsPath = WORKFLOWS_PATH, ...restWorkerOpts } = args.workerOptions ?? {};
    const workflowBundle = await getBundle(plugin, workflowsPath, JSON.stringify(args.options ?? {}));

    // Roll the collector back on retry so assertions never see a stalled
    // attempt's partial emissions.
    const preAttemptState = args.collector.snapshot();

    for (let attempt = 1; ; attempt++) {
      const taskQueue = args.taskQueue ?? `langsmith-test-${randomUUID()}`;

      const worker = await Worker.create({
        connection: env.nativeConnection,
        namespace: env.namespace,
        taskQueue,
        workflowBundle,
        activities: args.activities,
        plugins: [plugin],
        // Avoid waiting for the default 10s sticky execution timeout on worker
        // transition: these short-lived per-case workers can otherwise stall a
        // full 10s on task redelivery and, on loaded CI, blow the 120s AVA cap.
        stickyQueueScheduleToStartTimeout: '1s',
        ...restWorkerOpts,
      });

      const client = new Client({
        connection: env.connection,
        namespace: env.namespace,
        plugins: [plugin],
      });

      try {
        // Deferred body (function form): the worker is polling before the body
        // starts any workflow.
        return await worker.runUntil(async () => {
          let stallTimer: ReturnType<typeof setTimeout> | undefined;
          const stall = new Promise<never>((_, reject) => {
            stallTimer = setTimeout(() => reject(new HarnessStallError(taskQueue, attempt)), BODY_STALL_TIMEOUT_MS);
          });
          try {
            return await Promise.race([args.body({ client, taskQueue, env }), stall]);
          } finally {
            clearTimeout(stallTimer);
          }
        });
      } catch (err) {
        if (!(err instanceof HarnessStallError) || attempt >= MAX_BODY_ATTEMPTS) {
          throw err;
        }
        // Load-bearing, do not remove: surfaces in the archived test log so CI
        // stalls stay diagnosable, AND (as worker stdout) debounces AVA's
        // inactivity watchdog so continued attempts can't trip it — see the
        // calibration notes on MAX_BODY_ATTEMPTS.
        console.warn(`withTracingWorker: ${err.message}; retrying on a fresh worker`);
        await terminateLeakedWorkflows(env, taskQueue);
        args.collector.restore(preAttemptState);
      }
    }
  } finally {
    if (privateEnv) await privateEnv.teardown();
  }
}
