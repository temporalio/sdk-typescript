import { randomUUID } from 'crypto';
import { status as grpcStatus } from '@grpc/grpc-js';
import { ErrorConstructor, ExecutionContext, TestFn } from 'ava';
import {
  isGrpcServiceError,
  WorkflowFailedError,
  WorkflowHandle,
  WorkflowHandleWithFirstExecutionRunId,
  WorkflowStartOptions,
  WorkflowUpdateFailedError,
} from '@temporalio/client';
import {
  LocalTestWorkflowEnvironmentOptions,
  workflowInterceptorModules as defaultWorkflowInterceptorModules,
} from '@temporalio/testing';
import {
  DefaultLogger,
  LogEntry,
  LogLevel,
  ReplayWorkerOptions,
  Runtime,
  WorkerOptions,
  WorkflowBundle,
  WorkflowBundleWithSourceMap,
  bundleWorkflowCode,
  makeTelemetryFilterString,
} from '@temporalio/worker';
import * as workflow from '@temporalio/workflow';
import { temporal } from '@temporalio/proto';
import { ConnectionInjectorInterceptor } from './activities/interceptors';
import {
  Worker,
  TestWorkflowEnvironment,
  test as anyTest,
  bundlerOptions,
  registerDefaultCustomSearchAttributes,
} from './helpers';

export interface Context {
  env: TestWorkflowEnvironment;
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

function setupRuntime(recordedLogs?: { [workflowId: string]: LogEntry[] }) {
  const logger = recordedLogs
    ? new DefaultLogger('DEBUG', (entry) => {
        const workflowId = (entry.meta as any)?.workflowInfo?.workflowId ?? (entry.meta as any)?.workflowId;
        recordedLogs![workflowId] ??= [];
        recordedLogs![workflowId].push(entry);
      })
    : new DefaultLogger((process.env.TEST_LOG_LEVEL || 'DEBUG').toUpperCase() as LogLevel);
  Runtime.install({
    logger,
    telemetryOptions: {
      logging: {
        filter: makeTelemetryFilterString({
          core: (process.env.TEST_LOG_LEVEL || 'INFO').toUpperCase() as LogLevel,
        }),
      },
    },
  });
}

export interface HelperTestBundleOptions {
  workflowsPath: string;
  workflowInterceptorModules?: string[];
}

export async function createTestWorkflowBundle({
  workflowsPath,
  workflowInterceptorModules,
}: HelperTestBundleOptions): Promise<WorkflowBundleWithSourceMap> {
  return await bundleWorkflowCode({
    ...bundlerOptions,
    workflowInterceptorModules: [...defaultWorkflowInterceptorModules, ...(workflowInterceptorModules ?? [])],
    workflowsPath,
    logger: new DefaultLogger('WARN'),
  });
}

export async function createLocalTestEnvironment(
  opts?: LocalTestWorkflowEnvironmentOptions
): Promise<TestWorkflowEnvironment> {
  return await TestWorkflowEnvironment.createLocal({
    ...(opts || {}), // Use provided options or default to an empty object
    server: {
      ...(opts?.server || {}), // Use provided server options or default to an empty object
      extraArgs: [
        ...defaultDynamicConfigOptions.flatMap((opt) => ['--dynamic-config-value', opt]),
        ...(opts?.server?.extraArgs ?? []),
      ],
    },
  });
}

export function makeConfigurableEnvironmentTestFn<T>(opts: {
  recordedLogs?: { [workflowId: string]: LogEntry[] };
  createTestContext: (t: ExecutionContext) => Promise<T>;
  teardown: (t: T) => Promise<void>;
}): TestFn<T> {
  const test = anyTest as TestFn<T>;
  test.before(async (t) => {
    setupRuntime(opts.recordedLogs);
    t.context = await opts.createTestContext(t);
  });
  test.after.always(async (t) => {
    await opts.teardown(t.context);
  });
  return test;
}

export function makeTestFunction(opts: {
  workflowsPath: string;
  workflowEnvironmentOpts?: LocalTestWorkflowEnvironmentOptions;
  workflowInterceptorModules?: string[];
  recordedLogs?: { [workflowId: string]: LogEntry[] };
}): TestFn<Context> {
  return makeConfigurableEnvironmentTestFn<Context>({
    recordedLogs: opts.recordedLogs,
    createTestContext: async (_t: ExecutionContext): Promise<Context> => {
      const env = await createLocalTestEnvironment(opts.workflowEnvironmentOpts);
      await registerDefaultCustomSearchAttributes(env.connection);
      return {
        workflowBundle: await createTestWorkflowBundle({
          workflowsPath: opts.workflowsPath,
          workflowInterceptorModules: opts.workflowInterceptorModules,
        }),
        env,
      };
    },
    teardown: async (c: Context) => {
      await c.env.teardown();
    },
  });
}

export interface Helpers {
  taskQueue: string;
  createWorker(opts?: Partial<WorkerOptions>): Promise<Worker>;
  runReplayHistory(opts: Partial<ReplayWorkerOptions>, history: temporal.api.history.v1.IHistory): Promise<void>;
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
  assertWorkflowUpdateFailed(p: Promise<any>, causeConstructor: ErrorConstructor, message?: string): Promise<void>;
  assertWorkflowFailedError(p: Promise<any>, causeConstructor: ErrorConstructor, message?: string): Promise<void>;
  updateHasBeenAdmitted(handle: WorkflowHandle<workflow.Workflow>, updateId: string): Promise<boolean>;
}

export function configurableHelpers<T>(
  t: ExecutionContext<T>,
  workflowBundle: WorkflowBundle,
  testEnv: TestWorkflowEnvironment
): Helpers {
  const taskQueue = t.title.replace(/ /g, '_');

  return {
    taskQueue,
    async createWorker(opts?: Partial<WorkerOptions>): Promise<Worker> {
      return await Worker.create({
        connection: testEnv.nativeConnection,
        workflowBundle,
        taskQueue,
        interceptors: {
          activity: [() => ({ inbound: new ConnectionInjectorInterceptor(testEnv.connection) })],
        },
        showStackTraceSources: true,
        ...opts,
      });
    },
    async runReplayHistory(
      opts: Partial<ReplayWorkerOptions>,
      history: temporal.api.history.v1.IHistory
    ): Promise<void> {
      await Worker.runReplayHistory(
        {
          workflowBundle,
          ...opts,
        },
        history
      );
    },
    async executeWorkflow(
      fn: workflow.Workflow,
      opts?: Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'> & Partial<Pick<WorkflowStartOptions, 'workflowId'>>
    ): Promise<any> {
      return await testEnv.client.workflow.execute(fn, {
        taskQueue,
        workflowId: randomUUID(),
        ...opts,
      });
    },
    async startWorkflow(
      fn: workflow.Workflow,
      opts?: Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'> & Partial<Pick<WorkflowStartOptions, 'workflowId'>>
    ): Promise<WorkflowHandleWithFirstExecutionRunId<workflow.Workflow>> {
      return await testEnv.client.workflow.start(fn, {
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
    async updateHasBeenAdmitted(handle: WorkflowHandle<workflow.Workflow>, updateId: string): Promise<boolean> {
      try {
        await testEnv.client.workflowService.pollWorkflowExecutionUpdate({
          namespace: testEnv.client.options.namespace,
          updateRef: {
            workflowExecution: { workflowId: handle.workflowId },
            updateId,
          },
        });
        return true;
      } catch (err) {
        if (isGrpcServiceError(err) && err.code === grpcStatus.NOT_FOUND) {
          return false;
        }
        throw err;
      }
    },
  };
}

export function helpers(t: ExecutionContext<Context>, testEnv: TestWorkflowEnvironment = t.context.env): Helpers {
  return configurableHelpers(t, t.context.workflowBundle, testEnv);
}
