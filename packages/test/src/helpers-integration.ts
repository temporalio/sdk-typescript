import { randomUUID } from 'crypto';
import { status as grpcStatus } from '@grpc/grpc-js';
import { ErrorConstructor, ExecutionContext, TestFn } from 'ava';
import {
  isGrpcServiceError,
  StartWorkflowOperation,
  UpdateDefinition,
  WorkflowFailedError,
  WorkflowHandle,
  WorkflowStartOptions,
  WorkflowUpdateFailedError,
  WorkflowUpdateHandle,
  WorkflowUpdateOptions,
  WorkflowUpdateStage,
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
  'frontend.enableExecuteMultiOperation=true',
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
  workflowEnvironmentOpts?: LocalTestWorkflowEnvironmentOptions;
  workflowInterceptorModules?: string[];
  recordedLogs?: { [workflowId: string]: LogEntry[] };
}): TestFn<Context> {
  const test = anyTest as TestFn<Context>;
  test.before(async (t) => {
    const workflowBundle = await bundleWorkflowCode({
      ...bundlerOptions,
      workflowInterceptorModules: [...defaultWorkflowInterceptorModules, ...(opts.workflowInterceptorModules ?? [])],
      workflowsPath: opts.workflowsPath,
      logger: new DefaultLogger('WARN'),
    });
    const logger = opts.recordedLogs
      ? new DefaultLogger('DEBUG', (entry) => {
          const workflowId = (entry.meta as any)?.workflowInfo?.workflowId ?? (entry.meta as any)?.workflowId;
          opts.recordedLogs![workflowId] ??= [];
          opts.recordedLogs![workflowId].push(entry);
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
    const env = await TestWorkflowEnvironment.createLocal({
      ...opts.workflowEnvironmentOpts,
      server: {
        ...opts.workflowEnvironmentOpts?.server,
        extraArgs: [
          ...defaultDynamicConfigOptions.flatMap((opt) => ['--dynamic-config-value', opt]),
          ...(opts.workflowEnvironmentOpts?.server?.extraArgs ?? []),
        ],
      },
    });
    await registerDefaultCustomSearchAttributes(env.connection);
    t.context = {
      env,
      workflowBundle,
    };
  });
  test.after.always(async (t) => {
    await t.context.env.teardown();
  });
  return test;
}

export interface Helpers {
  taskQueue: string;
  createWorker(opts?: Partial<WorkerOptions>): Promise<Worker>;
  runReplayHistory(opts: Partial<ReplayWorkerOptions>, history: temporal.api.history.v1.IHistory): Promise<void>;
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
  startUpdateWithStart(
    updateDef: UpdateDefinition<any, any, any> | string,
    updateOptions: WorkflowUpdateOptions & { args?: any[], waitForStage: WorkflowUpdateStage.ACCEPTED },
    startWorkflowOperation: {
      workflowTypeOrFunc: workflow.Workflow,
      options?: Omit<WorkflowStartOptions<workflow.Workflow>, 'taskQueue' | 'workflowId'>
    }
  ): Promise<WorkflowUpdateHandle<any>>;
  executeUpdateWithStart(
    updateDef: UpdateDefinition<any, any, any> | string,
    updateOptions: WorkflowUpdateOptions & { args?: any[], waitForStage: WorkflowUpdateStage.COMPLETED },
    startWorkflowOperation: {
      workflowTypeOrFunc: workflow.Workflow,
      options?: Omit<WorkflowStartOptions<workflow.Workflow>, 'taskQueue' | 'workflowId'>
    }
  ): Promise<any>;
  assertWorkflowUpdateFailed(p: Promise<any>, causeConstructor: ErrorConstructor, message?: string): Promise<void>;
  assertWorkflowFailedError(p: Promise<any>, causeConstructor: ErrorConstructor, message?: string): Promise<void>;
  updateHasBeenAdmitted(handle: WorkflowHandle<workflow.Workflow>, updateId: string): Promise<boolean>;
}

export function helpers(t: ExecutionContext<Context>, testEnv: TestWorkflowEnvironment = t.context.env): Helpers {
  const taskQueue = t.title.replace(/ /g, '_');

  return {
    taskQueue,
    async createWorker(opts?: Partial<WorkerOptions>): Promise<Worker> {
      return await Worker.create({
        connection: testEnv.nativeConnection,
        workflowBundle: t.context.workflowBundle,
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
          workflowBundle: t.context.workflowBundle,
          ...opts,
        },
        history
      );
    },
    async executeWorkflow(
      fn: workflow.Workflow,
      opts?: Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'>
    ): Promise<any> {
      return await testEnv.client.workflow.execute(fn, {
        taskQueue,
        workflowId: randomUUID(),
        ...opts,
      });
    },
    async startWorkflow(
      fn: workflow.Workflow,
      opts?: Omit<WorkflowStartOptions, 'taskQueue' | 'workflowId'>
    ): Promise<WorkflowHandle<workflow.Workflow>> {
      return await testEnv.client.workflow.start(fn, {
        taskQueue,
        workflowId: randomUUID(),
        ...opts,
      });
    },
    async startUpdateWithStart(
      updateDef: UpdateDefinition<any, any, any> | string,
      updateOptions: WorkflowUpdateOptions & { args?: any[], waitForStage: WorkflowUpdateStage.ACCEPTED },
      startWorkflowOperation: {
        workflowTypeOrFunc: workflow.Workflow,
        options?: Omit<WorkflowStartOptions<workflow.Workflow>, 'taskQueue' | 'workflowId'>
      }
    ): Promise<WorkflowUpdateHandle<any>> {
      return await testEnv.client.workflow.startUpdateWithStart(updateDef, updateOptions, {
        workflowTypeOrFunc: startWorkflowOperation.workflowTypeOrFunc,
        options: {
          taskQueue,
          workflowId: randomUUID(),
          ...(startWorkflowOperation.options ?? {}),
        },
      });
    },
    async executeUpdateWithStart(
      updateDef: UpdateDefinition<any, any, any> | string,
      updateOptions: WorkflowUpdateOptions & { args?: any[], waitForStage: WorkflowUpdateStage.COMPLETED },
      startWorkflowOperation: {
        workflowTypeOrFunc: workflow.Workflow,
        options?: Omit<WorkflowStartOptions<workflow.Workflow>, 'taskQueue' | 'workflowId'>
      }
    ): Promise<any> {
      return await testEnv.client.workflow.executeUpdateWithStart(updateDef, updateOptions, {
        workflowTypeOrFunc: startWorkflowOperation.workflowTypeOrFunc,
        options: {
          taskQueue,
          workflowId: randomUUID(),
          ...(startWorkflowOperation.options || {}),
        },
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
