import { randomUUID } from 'crypto';
import type { ExecutionContext } from 'ava';
import { WorkflowHandleWithFirstExecutionRunId, WorkflowStartOptions } from '@temporalio/client';
import type { TestWorkflowEnvironment as RealTestWorkflowEnvironment } from '@temporalio/testing';
import { WorkerOptions, WorkflowBundle } from '@temporalio/worker';
import * as workflow from '@temporalio/workflow';
import { Worker, TestWorkflowEnvironment } from './wrappers';

export const isBun = typeof (globalThis as any).Bun !== 'undefined';

/**
 * Base context interface for test environments.
 * Contains the minimum required fields for test context.
 */
export interface BaseContext {
  env: TestWorkflowEnvironment | RealTestWorkflowEnvironment;
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
 * Options for creating helpers
 */
export interface CreateHelpersOptions<T extends BaseContext> {
  /** The test execution context */
  t: ExecutionContext<T>;
  /** The workflow bundle to use */
  workflowBundle: WorkflowBundle;
  /** The test workflow environment */
  testEnv: TestWorkflowEnvironment | RealTestWorkflowEnvironment;
  /** Optional function to transform the task queue name from test title */
  taskQueueTransform?: (title: string) => string;
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
 * Create base helpers for a test.
 *
 * @param opts - Options for creating helpers
 * @returns BaseHelpers instance
 */
export function createHelpers<T extends BaseContext>(opts: CreateHelpersOptions<T>): BaseHelpers {
  const { t, workflowBundle, testEnv, taskQueueTransform = defaultTaskQueueTransform } = opts;
  const taskQueue = taskQueueTransform(t.title);

  return {
    taskQueue,
    async createWorker(workerOpts?: Partial<WorkerOptions>): Promise<Worker> {
      return await Worker.create({
        connection: testEnv.nativeConnection,
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
      return await testEnv.client.workflow.execute(fn, {
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
      return await testEnv.client.workflow.start(fn, {
        taskQueue,
        workflowId: randomUUID(),
        ...workflowOpts,
      });
    },
  };
}

/**
 * Simple helpers factory for tests with BaseContext.
 * This is a convenience function that extracts env and workflowBundle from context.
 */
export function helpers<T extends BaseContext>(
  t: ExecutionContext<T>,
  testEnv: TestWorkflowEnvironment | RealTestWorkflowEnvironment = t.context.env
): BaseHelpers {
  return createHelpers({
    t,
    workflowBundle: t.context.workflowBundle,
    testEnv,
  });
}
