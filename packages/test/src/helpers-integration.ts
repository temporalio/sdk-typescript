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
  NexusEndpointIdentifier,
  workflowInterceptorModules as defaultWorkflowInterceptorModules,
} from '@temporalio/testing';
import {
  DefaultLogger,
  LogEntry,
  LogLevel,
  NativeConnection,
  NativeConnectionOptions,
  ReplayWorkerOptions,
  Runtime,
  RuntimeOptions,
  WorkerOptions,
  WorkflowBundle,
  WorkflowBundleWithSourceMap,
  bundleWorkflowCode,
  makeTelemetryFilterString,
} from '@temporalio/worker';
import * as workflow from '@temporalio/workflow';
import { temporal } from '@temporalio/proto';
import { defineSearchAttributeKey, SearchAttributeType } from '@temporalio/common/lib/search-attributes';
import { Worker, TestWorkflowEnvironment, test as anyTest, bundlerOptions } from './helpers';

export interface Context {
  env: TestWorkflowEnvironment;
  workflowBundle: WorkflowBundle;
}

const defaultDynamicConfigOptions = [
  'system.enableActivityEagerExecution=true',
  'history.enableRequestIdRefLinks=true',
];

function setupRuntime(recordedLogs?: { [workflowId: string]: LogEntry[] }, runtimeOpts?: Partial<RuntimeOptions>) {
  const logger = recordedLogs
    ? new DefaultLogger('DEBUG', (entry) => {
        const workflowId = (entry.meta as any)?.workflowInfo?.workflowId ?? (entry.meta as any)?.workflowId;
        recordedLogs![workflowId] ??= [];
        recordedLogs![workflowId].push(entry);
      })
    : new DefaultLogger((process.env.TEST_LOG_LEVEL || 'ERROR').toUpperCase() as LogLevel);
  Runtime.install({
    ...runtimeOpts,
    logger,
    telemetryOptions: {
      ...runtimeOpts?.telemetryOptions,
      logging: {
        ...runtimeOpts?.telemetryOptions?.logging,
        filter: makeTelemetryFilterString({
          core: (process.env.TEST_LOG_LEVEL || 'ERROR').toUpperCase() as LogLevel,
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

export const defaultSAKeys = {
  CustomIntField: defineSearchAttributeKey('CustomIntField', SearchAttributeType.INT),
  CustomBoolField: defineSearchAttributeKey('CustomBoolField', SearchAttributeType.BOOL),
  CustomKeywordField: defineSearchAttributeKey('CustomKeywordField', SearchAttributeType.KEYWORD),
  CustomTextField: defineSearchAttributeKey('CustomTextField', SearchAttributeType.TEXT),
  CustomDatetimeField: defineSearchAttributeKey('CustomDatetimeField', SearchAttributeType.DATETIME),
  CustomDoubleField: defineSearchAttributeKey('CustomDoubleField', SearchAttributeType.DOUBLE),
};

export async function createLocalTestEnvironment(
  opts?: LocalTestWorkflowEnvironmentOptions
): Promise<TestWorkflowEnvironment> {
  return await TestWorkflowEnvironment.createLocal({
    ...(opts || {}), // Use provided options or default to an empty object
    server: {
      searchAttributes: Object.values(defaultSAKeys),
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
  runtimeOpts?: Partial<RuntimeOptions> | (() => Promise<[Partial<RuntimeOptions>, Partial<T>]>) | undefined;
}): TestFn<T> {
  const test = anyTest as TestFn<T>;
  test.before(async (t) => {
    const [runtimeOpts, extraContext] =
      typeof opts.runtimeOpts === 'function' ? await opts.runtimeOpts() : [opts.runtimeOpts, {}];
    setupRuntime(opts.recordedLogs, runtimeOpts);
    t.context = { ...(await opts.createTestContext(t)), ...extraContext };
  });
  test.after.always(async (t) => {
    await opts.teardown(t.context);
  });
  return test;
}

export interface TestFunctionOptions<C extends Context> {
  workflowsPath: string;
  workflowEnvironmentOpts?: LocalTestWorkflowEnvironmentOptions;
  workflowInterceptorModules?: string[];
  recordedLogs?: { [workflowId: string]: LogEntry[] };
  runtimeOpts?: Partial<RuntimeOptions> | (() => Promise<[Partial<RuntimeOptions>, Partial<C>]>) | undefined;
}

export function makeTestFunction<C extends Context = Context>(opts: TestFunctionOptions<C>): TestFn<C> {
  return makeConfigurableEnvironmentTestFn<C>({
    recordedLogs: opts.recordedLogs,
    runtimeOpts: opts.runtimeOpts,
    createTestContext: makeDefaultTestContextFunction(opts),
    teardown: async (c: C) => {
      if (c.env) {
        await c.env.teardown();
      }
    },
  });
}

export function makeDefaultTestContextFunction<C extends Context = Context>(opts: TestFunctionOptions<C>) {
  return async (_t: ExecutionContext): Promise<C> => {
    const env = await createTestWorkflowEnvironment(opts.workflowEnvironmentOpts);
    return {
      workflowBundle: await createTestWorkflowBundle({
        workflowsPath: opts.workflowsPath,
        workflowInterceptorModules: opts.workflowInterceptorModules,
      }),
      env,
    } as unknown as C;
  };
}

export async function createTestWorkflowEnvironment(
  opts?: LocalTestWorkflowEnvironmentOptions
): Promise<TestWorkflowEnvironment> {
  let env: TestWorkflowEnvironment;
  if (process.env.TEMPORAL_SERVICE_ADDRESS) {
    env = await TestWorkflowEnvironment.createFromExistingServer({
      address: process.env.TEMPORAL_SERVICE_ADDRESS,
    });
  } else {
    env = await createLocalTestEnvironment(opts);
  }
  return env;
}

export interface Helpers {
  taskQueue: string;
  createWorker(opts?: Partial<WorkerOptions>): Promise<Worker>;
  createNativeConnection(opts?: Partial<NativeConnectionOptions>): Promise<NativeConnection>;
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
  registerNexusEndpoint(
    suffix?: string
  ): Promise<{ endpointName: string; endpointIdentifier: NexusEndpointIdentifier }>;
}

export function configurableHelpers<T>(
  t: ExecutionContext<T>,
  workflowBundle: WorkflowBundle,
  testEnv: TestWorkflowEnvironment
): Helpers {
  const taskQueue = t.title
    .toLowerCase()
    .replaceAll(/[ _()'-]+/g, '-')
    .replace(/^[-]?(.+?)[-]?$/, '$1');

  return {
    taskQueue,
    async createWorker(opts?: Partial<WorkerOptions>): Promise<Worker> {
      return await Worker.create({
        connection: testEnv.nativeConnection,
        workflowBundle,
        taskQueue,
        showStackTraceSources: true,
        ...opts,
      });
    },
    async createNativeConnection(opts?: Partial<NativeConnectionOptions>): Promise<NativeConnection> {
      return await NativeConnection.connect({ address: testEnv.address, ...opts });
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
    async registerNexusEndpoint(
      suffix?: string
    ): Promise<{ endpointName: string; endpointIdentifier: NexusEndpointIdentifier }> {
      const endpointName = (suffix ? `${taskQueue}-${suffix}` : taskQueue).replaceAll('_', '-');
      try {
        const endpointIdentifier = await testEnv.createNexusEndpoint(endpointName, taskQueue);
        t.teardown(() =>
          testEnv.deleteNexusEndpoint(endpointIdentifier).catch(() => {
            /* ignore cleanup errors */
          })
        );
        return { endpointName, endpointIdentifier };
      } catch (err) {
        if (err instanceof Error) {
          err.message = `Failed to register Nexus endpoint '${endpointName}': ${err.message}`;
        }
        throw err;
      }
    },
  };
}

export function helpers(t: ExecutionContext<Context>, testEnv: TestWorkflowEnvironment = t.context.env): Helpers {
  return configurableHelpers(t, t.context.workflowBundle, testEnv);
}
