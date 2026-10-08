import { randomUUID } from 'crypto';
import type { ExecutionContext } from 'ava';
import type { WorkflowHandleWithFirstExecutionRunId, WorkflowStartOptions } from '@temporalio/client';
import type { TestWorkflowEnvironment as RealTestWorkflowEnvironment } from '@temporalio/testing';
import type { WorkerOptions, WorkflowBundle } from '@temporalio/worker';
import type * as workflow from '@temporalio/workflow';
import type { TestWorkflowEnvironment } from './wrappers';
import { Worker } from './wrappers';

export const isBun = typeof (globalThis as any).Bun !== 'undefined';
/** Union type for all supported test environment types */
export type AnyTestWorkflowEnvironment = TestWorkflowEnvironment | RealTestWorkflowEnvironment;

/**
 * Base context interface for test environments.
 * Generic parameter allows specifying a more specific environment type.
 * Defaults to TestWorkflowEnvironment since that's the most common case.
 */
export interface BaseContext<TEnv extends AnyTestWorkflowEnvironment = TestWorkflowEnvironment> {
  env: TEnv;
  workflowBundle: WorkflowBundle;
}

/**
 * Base helpers interface providing common test utilities.
 * Packages can extend this interface with additional methods.
 */
export interface BaseHelpers {
  readonly taskQueue: string;
  createWorker(opts?: Partial<WorkerOptions>): Promise<Worker>;
  executeWorkflow<T extends () => Promise<any>>(workflowType: T): Promise<workflow.WorkflowResultType<T>>;
  executeWorkflow<T extends workflow.Workflow>(
    fn: T,
    opts: Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'> & Partial<Pick<WorkflowStartOptions, 'workflowId'>>
  ): Promise<workflow.WorkflowResultType<T>>;
  startWorkflow<T extends () => Promise<any>>(workflowType: T): Promise<WorkflowHandleWithFirstExecutionRunId<T>>;
  startWorkflow<T extends workflow.Workflow>(
    fn: T,
    opts: Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'> & Partial<Pick<WorkflowStartOptions, 'workflowId'>>
  ): Promise<WorkflowHandleWithFirstExecutionRunId<T>>;
}

// Test titles are only unique within a file, while test files may share a server or namespace (e.g. on Cloud, or
// when AVA runs files concurrently). Each test file runs in its own process, so a per-process suffix keeps task
// queues apart across files. Computed lazily so that importing this module from Workflow code stays side-effect free.
let processTaskQueueSuffix: string | undefined;

/**
 * Default task queue transform function that converts test title to a valid task queue name, unique to this process.
 */
export function defaultTaskQueueTransform(title: string): string {
  processTaskQueueSuffix ??= randomUUID().slice(0, 8);
  const base = title
    .toLowerCase()
    .replaceAll(/[ _()'-]+/g, '-')
    .replace(/^[-]?(.+?)[-]?$/, '$1');
  return `${base}-${processTaskQueueSuffix}`;
}

/**
 * Reject Worker options that the Worker would silently ignore.
 *
 * When `workflowBundle` is set, the Worker logs a warning and ignores `workflowsPath`, `bundlerOptions` and
 * `interceptors.workflowModules`, so a test passing them would run different Workflow code than it intends.
 */
function assertWorkflowSourceOptionsApply(workerOpts: Partial<WorkerOptions>): void {
  const hasWorkflowsPath = workerOpts.workflowsPath !== undefined;
  const hasBundleTimeOptions =
    workerOpts.bundlerOptions !== undefined || workerOpts.interceptors?.workflowModules !== undefined;
  if (workerOpts.workflowBundle !== undefined && (hasWorkflowsPath || hasBundleTimeOptions)) {
    throw new TypeError(
      'createWorker() was given workflowBundle together with workflowsPath, bundlerOptions or ' +
        'interceptors.workflowModules; the Worker ignores the latter when a prebuilt bundle is used'
    );
  }
  if (!hasWorkflowsPath && workerOpts.workflowBundle === undefined && hasBundleTimeOptions) {
    throw new TypeError(
      'createWorker() was given bundlerOptions or interceptors.workflowModules without workflowsPath; ' +
        'these options are ignored when the suite workflow bundle is used'
    );
  }
}

/**
 * Whether Worker options select their own Workflow code, in which case the suite bundle must not be injected.
 */
function definesWorkflowSource(workerOpts: Partial<WorkerOptions>): boolean {
  return 'workflowBundle' in workerOpts || 'workflowsPath' in workerOpts;
}

/**
 * Create helpers for a test.
 *
 * When called with just `t`, extracts env and workflowBundle from `t.context`.
 * When called with `t` and `env`, uses the provided env with workflowBundle from context.
 *
 * @param t - The test execution context
 * @param env - Optional environment override (defaults to t.context.env)
 * @returns BaseHelpers instance
 */
export function helpers<TEnv extends AnyTestWorkflowEnvironment = TestWorkflowEnvironment>(
  t: ExecutionContext<BaseContext<TEnv>>,
  env: AnyTestWorkflowEnvironment = t.context.env
): BaseHelpers {
  // createBaseHelpers(t.title, env, t.context.workflowBundle);
  const taskQueue = defaultTaskQueueTransform(t.title);
  const workflowBundle = t.context.workflowBundle;

  return {
    taskQueue,
    async createWorker(workerOpts: Partial<WorkerOptions> = {}): Promise<Worker> {
      assertWorkflowSourceOptionsApply(workerOpts);
      return await Worker.create({
        connection: env.nativeConnection,
        namespace: env.namespace,
        ...(definesWorkflowSource(workerOpts) ? {} : { workflowBundle }),
        taskQueue,
        showStackTraceSources: true,
        ...workerOpts,
      });
    },
    async executeWorkflow(
      fn: workflow.Workflow,
      workflowOpts?: Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'> &
        Partial<Pick<WorkflowStartOptions, 'workflowId'>>
    ): Promise<any> {
      return await env.client.workflow.execute(fn, {
        taskQueue,
        workflowId: randomUUID(),
        ...workflowOpts,
      });
    },
    async startWorkflow(
      fn: workflow.Workflow,
      workflowOpts?: Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'> &
        Partial<Pick<WorkflowStartOptions, 'workflowId'>>
    ): Promise<WorkflowHandleWithFirstExecutionRunId<workflow.Workflow>> {
      return await env.client.workflow.start(fn, {
        taskQueue,
        workflowId: randomUUID(),
        ...workflowOpts,
      });
    },
  };
}
