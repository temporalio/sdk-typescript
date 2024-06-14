import { randomUUID } from 'crypto';
import { ErrorConstructor, ExecutionContext, TestFn } from 'ava';
import {
  WorkflowFailedError,
  WorkflowHandle,
  WorkflowStartOptions,
  WorkflowUpdateFailedError,
} from '@temporalio/client';
import {
  LocalTestWorkflowEnvironmentOptions,
  workflowInterceptorModules as defaultWorkflowInterceptorModules,
} from '@temporalio/testing';
import {
  DefaultLogger,
  LogLevel,
  Runtime,
  WorkerOptions,
  WorkflowBundle,
  bundleWorkflowCode,
} from '@temporalio/worker';
import * as workflow from '@temporalio/workflow';
import { ConnectionInjectorInterceptor } from './activities/interceptors';
import {
  Worker,
  TestWorkflowEnvironment,
  test as anyTest,
  bundlerOptions,
  registerDefaultCustomSearchAttributes,
  RUN_TIME_SKIPPING_TESTS,
} from './helpers';

export interface Context {
  envLocal: TestWorkflowEnvironment;
  // Not supported on Linux ARM64
  envTimeSkipping: TestWorkflowEnvironment | undefined;
  workflowBundle: WorkflowBundle;
}

const defaultDynamicConfigOptions = [
  'frontend.enableUpdateWorkflowExecution=true',
  'frontend.enableUpdateWorkflowExecutionAsyncAccepted=true',
  'frontend.workerVersioningDataAPIs=true',
  'frontend.workerVersioningWorkflowAPIs=true',
  'system.enableActivityEagerExecution=true',
  'system.enableEagerWorkflowStart=true',
  'system.forceSearchAttributesCacheRefreshOnRead=true',
  'worker.buildIdScavengerEnabled=true',
  'worker.removableBuildIdDurationSinceDefault=1',
];

export function makeTestFunction(opts: {
  workflowsPath: string;
  localWorkflowEnvironmentOpts?: LocalTestWorkflowEnvironmentOptions;
  timeSkippingWorkflowEnvironmentOpts?: LocalTestWorkflowEnvironmentOptions;
  workflowInterceptorModules?: string[];
}): TestFn<Context> {
  const test = anyTest as TestFn<Context>;
  test.before(async (t) => {
    // Ignore invalid log levels
    Runtime.install({ logger: new DefaultLogger((process.env.TEST_LOG_LEVEL || 'DEBUG').toUpperCase() as LogLevel) });
    const envLocal = await TestWorkflowEnvironment.createLocal({
      ...opts.localWorkflowEnvironmentOpts,
      server: {
        ...opts.localWorkflowEnvironmentOpts?.server,
        extraArgs: [
          ...defaultDynamicConfigOptions.flatMap((opt) => ['--dynamic-config-value', opt]),
          ...(opts.localWorkflowEnvironmentOpts?.server?.extraArgs ?? []),
        ],
      },
    });
    await registerDefaultCustomSearchAttributes(envLocal.connection);
    const envTimeSkipping = RUN_TIME_SKIPPING_TESTS
      ? await TestWorkflowEnvironment.createTimeSkipping({
          ...opts.timeSkippingWorkflowEnvironmentOpts,
          server: {
            ...opts.timeSkippingWorkflowEnvironmentOpts?.server,
            extraArgs: [...(opts.timeSkippingWorkflowEnvironmentOpts?.server?.extraArgs ?? [])],
          },
        })
      : undefined;
    const workflowBundle = await bundleWorkflowCode({
      ...bundlerOptions,
      workflowInterceptorModules: [...defaultWorkflowInterceptorModules, ...(opts.workflowInterceptorModules ?? [])],
      workflowsPath: opts.workflowsPath,
    });
    t.context = {
      envLocal,
      envTimeSkipping,
      workflowBundle,
    };
  });
  test.after.always(async (t) => {
    await t.context.envLocal.teardown();
    if (t.context.envTimeSkipping) {
      await t.context.envTimeSkipping.teardown();
    }
  });
  return test;
}

export interface Helpers {
  taskQueue: string;
  createWorker(opts?: Partial<WorkerOptions>): Promise<Worker>;
  executeWorkflow<T extends () => Promise<any>>(workflowType: T): Promise<workflow.WorkflowResultType<T>>;
  executeWorkflow<T extends workflow.Workflow>(
    fn: T,
    opts: Omit<WorkflowStartOptions<T>, 'taskQueue' | 'workflowId'>
  ): Promise<workflow.WorkflowResultType<T>>;
  startWorkflow<T extends () => Promise<any>>(workflowType: T): Promise<WorkflowHandle<T>>;
  startWorkflow<T extends workflow.Workflow>(
    fn: T,
    opts: Omit<WorkflowStartOptions<T>, 'taskQueue' | 'workflowId'>
  ): Promise<WorkflowHandle<T>>;
  assertWorkflowUpdateFailed(p: Promise<any>, causeConstructor: ErrorConstructor, message?: string): Promise<void>;
  assertWorkflowFailedError(p: Promise<any>, causeConstructor: ErrorConstructor, message?: string): Promise<void>;
}

export function helpers(t: ExecutionContext<Context>): Helpers {
  const taskQueue = t.title.replace(/ /g, '_');

  return {
    taskQueue,
    async createWorker(opts?: Partial<WorkerOptions>): Promise<Worker> {
      return await Worker.create({
        connection: t.context.envLocal.nativeConnection,
        workflowBundle: t.context.workflowBundle,
        taskQueue,
        interceptors: {
          activity: [() => ({ inbound: new ConnectionInjectorInterceptor(t.context.envLocal.connection) })],
        },
        showStackTraceSources: true,
        ...opts,
      });
    },
    async executeWorkflow(
      fn: workflow.Workflow,
      opts?: Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'>
    ): Promise<any> {
      return await t.context.envLocal.client.workflow.execute(fn, {
        taskQueue,
        workflowId: randomUUID(),
        ...opts,
      });
    },
    async startWorkflow(
      fn: workflow.Workflow,
      opts?: Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'>
    ): Promise<WorkflowHandle<workflow.Workflow>> {
      return await t.context.envLocal.client.workflow.start(fn, {
        taskQueue,
        workflowId: randomUUID(),
        ...opts,
      });
    },
    async assertWorkflowUpdateFailed(
      p: Promise<any>,
      causeConstructor: ErrorConstructor,
      message?: string
    ): Promise<void> {
      const err: WorkflowUpdateFailedError = (await t.throwsAsync(p, {
        instanceOf: WorkflowUpdateFailedError,
      })) as WorkflowUpdateFailedError;
      t.true(err.cause instanceof causeConstructor);
      if (message !== undefined) {
        t.is(err.cause?.message, message);
      }
    },
    async assertWorkflowFailedError(
      p: Promise<any>,
      causeConstructor: ErrorConstructor,
      message?: string
    ): Promise<void> {
      const err: WorkflowFailedError = (await t.throwsAsync(p, {
        instanceOf: WorkflowFailedError,
      })) as WorkflowFailedError;
      t.true(err.cause instanceof causeConstructor);
      if (message !== undefined) {
        t.is(err.cause?.message, message);
      }
    },
  };
}

export interface HelpersTimeSkipping extends Helpers {
  taskQueue: string;
  createWorker(opts?: Partial<WorkerOptions>): Promise<Worker>;
  executeWorkflow<T extends () => Promise<any>>(workflowType: T): Promise<workflow.WorkflowResultType<T>>;
  executeWorkflow<T extends workflow.Workflow>(
    fn: T,
    opts: Omit<WorkflowStartOptions<T>, 'taskQueue' | 'workflowId'>
  ): Promise<workflow.WorkflowResultType<T>>;
  startWorkflow<T extends () => Promise<any>>(workflowType: T): Promise<WorkflowHandle<T>>;
  startWorkflow<T extends workflow.Workflow>(
    fn: T,
    opts: Omit<WorkflowStartOptions<T>, 'taskQueue' | 'workflowId'>
  ): Promise<WorkflowHandle<T>>;
  assertWorkflowUpdateFailed(p: Promise<any>, causeConstructor: ErrorConstructor, message?: string): Promise<void>;
  assertWorkflowFailedError(p: Promise<any>, causeConstructor: ErrorConstructor, message?: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/**
 * Similar to `helpers`, but for use with the time-skipping test environment.
 * Note that time-skipping is global to the test environment, so it is generally
 * preferable to run time-skipping tests serially.
 */
export function helpersTimeSkipping(t: ExecutionContext<Context>): HelpersTimeSkipping {
  const taskQueue = t.title.replace(/ /g, '_');
  if (!t.context.envTimeSkipping) {
    throw new Error('Time skipping environment not available');
  }

  return {
    taskQueue,
    async createWorker(opts?: Partial<WorkerOptions>): Promise<Worker> {
      return await Worker.create({
        connection: t.context.envTimeSkipping!.nativeConnection,
        workflowBundle: t.context.workflowBundle,
        taskQueue,
        interceptors: {
          activity: [() => ({ inbound: new ConnectionInjectorInterceptor(t.context.envTimeSkipping.connection) })],
        },
        showStackTraceSources: true,
        ...opts,
      });
    },
    async executeWorkflow(
      fn: workflow.Workflow,
      opts?: Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'>
    ): Promise<any> {
      return await t.context.envTimeSkipping!.client.workflow.execute(fn, {
        taskQueue,
        workflowId: randomUUID(),
        ...opts,
      });
    },
    async startWorkflow(
      fn: workflow.Workflow,
      opts?: Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'>
    ): Promise<WorkflowHandle<workflow.Workflow>> {
      return await t.context.envTimeSkipping!.client.workflow.start(fn, {
        taskQueue,
        workflowId: randomUUID(),
        ...opts,
      });
    },
    async sleep(ms: number): Promise<void> {
      await t.context.envTimeSkipping!.sleep(ms);
    },
    async assertWorkflowUpdateFailed(
      p: Promise<any>,
      causeConstructor: ErrorConstructor,
      message?: string
    ): Promise<void> {
      const err: WorkflowUpdateFailedError = (await t.throwsAsync(p, {
        instanceOf: WorkflowUpdateFailedError,
      })) as WorkflowUpdateFailedError;
      t.true(err.cause instanceof causeConstructor);
      if (message !== undefined) {
        t.is(err.cause?.message, message);
      }
    },
    async assertWorkflowFailedError(
      p: Promise<any>,
      causeConstructor: ErrorConstructor,
      message?: string
    ): Promise<void> {
      const err: WorkflowFailedError = (await t.throwsAsync(p, {
        instanceOf: WorkflowFailedError,
      })) as WorkflowFailedError;
      t.true(err.cause instanceof causeConstructor);
      if (message !== undefined) {
        t.is(err.cause?.message, message);
      }
    },
  };
}
