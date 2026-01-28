import { randomUUID } from 'crypto';
import type { ExecutionContext } from 'ava';
import { WorkflowHandleWithFirstExecutionRunId, WorkflowStartOptions } from '@temporalio/client';
import type { TestWorkflowEnvironment as RealTestWorkflowEnvironment } from '@temporalio/testing';
import { WorkerOptions, WorkflowBundle } from '@temporalio/worker';
import * as workflow from '@temporalio/workflow';
import { Worker, TestWorkflowEnvironment } from './wrappers';

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

/**
 * Default task queue transform function that converts test title to a valid task queue name.
 */
export function defaultTaskQueueTransform(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[ _()'-]+/g, '-')
    .replace(/^[-]?(.+?)[-]?$/, '$1');
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
    async createWorker(workerOpts?: Partial<WorkerOptions>): Promise<Worker> {
      return await Worker.create({
        connection: env.nativeConnection,
        workflowBundle,
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
