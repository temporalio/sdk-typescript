/**
 * Shared test harness: {@link InMemoryRunCollector} captures every run the plugin
 * emits, and {@link dumpTraces} renders them as an indented tree for assertions.
 *
 * @module
 */

import type { Client as LangSmithClient } from 'langsmith';
import { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, type WorkerOptions } from '@temporalio/worker';

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

/** Boot a local Temporal env with the plugin on both client and worker, run `body`, then tear down. */
export async function withTracingWorker<T>(args: HarnessArgs<T>): Promise<T> {
  const env = await TestWorkflowEnvironment.createLocal();
  try {
    const taskQueue = args.taskQueue ?? 'langsmith-test';
    const plugin = new LangSmithPlugin({ ...args.options, client: args.collector.asClient() });

    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue,
      workflowsPath: WORKFLOWS_PATH,
      activities: args.activities,
      plugins: [plugin],
      // Avoid waiting for the default 10s sticky execution timeout on worker
      // transition: these short-lived per-case workers can otherwise stall a
      // full 10s on task redelivery and, on loaded CI, blow the 120s AVA cap.
      stickyQueueScheduleToStartTimeout: '1s',
      ...args.workerOptions,
    });

    const client = new Client({
      connection: env.connection,
      namespace: env.namespace,
      plugins: [plugin],
    });

    return await worker.runUntil(args.body({ client, taskQueue, env }));
  } finally {
    await env.teardown();
  }
}
