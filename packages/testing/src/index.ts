import * as activity from '@temporalio/activity';
import {
  AsyncCompletionClient,
  WorkflowClient as BaseWorkflowClient,
  WorkflowClientOptions,
  WorkflowResultOptions as BaseWorkflowResultOptions,
  WorkflowStartOptions as BaseWorkflowStartOptions,
} from '@temporalio/client';
import { ActivityFunction, CancelledFailure, msToTs, Workflow, WorkflowResultType } from '@temporalio/common';
import { NativeConnection, Logger, DefaultLogger } from '@temporalio/worker';
import path from 'path';
import os from 'os';
import { AbortController } from 'abort-controller';
import { ChildProcess, spawn, StdioOptions } from 'child_process';
import events from 'events';
import { kill, waitOnChild } from './child-process';
import type getPortType from 'get-port';
import { Connection, TestService } from './test-service-client';

const TEST_SERVER_EXECUTABLE_NAME = os.platform() === 'win32' ? 'test-server.exe' : 'test-server';

export const DEFAULT_TEST_SERVER_PATH = path.join(__dirname, `../${TEST_SERVER_EXECUTABLE_NAME}`);

/**
 * Options passed to {@link WorkflowClient.result}, these are the same as the
 * {@link BaseWorkflowResultOptions} with an additional option that controls
 * whether to toggle time skipping in the Test server while waiting on a
 * Workflow's result.
 */
export interface WorkflowResultOptions extends BaseWorkflowResultOptions {
  /**
   * If set to `true`, waiting for the result does not enable time skipping
   */
  runInNormalTime?: boolean;
}

/**
 * Options passed to {@link WorkflowClient.execute}, these are the same as the
 * {@link BaseWorkflowStartOptions} with an additional option that controls
 * whether to toggle time skipping in the Test server while waiting on a
 * Workflow's result.
 */
export type WorkflowStartOptions<T extends Workflow> = BaseWorkflowStartOptions<T> & {
  /**
   * If set to `true`, waiting for the result does not enable time skipping
   */
  runInNormalTime?: boolean;
};

/**
 * A client with the exact same API as the "normal" client with 1 exception,
 * When this client waits on a Workflow's result, it will enable time skipping
 * in the test server.
 */
export class WorkflowClient extends BaseWorkflowClient {
  protected readonly testService: TestService;

  constructor(connection: Connection, options?: WorkflowClientOptions | undefined) {
    super(connection, options);
    this.testService = connection.testService;
  }

  /**
   * Execute a Workflow and wait for completion.
   *
   * @see {@link BaseWorkflowClient.execute}
   */
  public async execute<T extends Workflow>(
    workflowTypeOrFunc: string | T,
    options: WorkflowStartOptions<T>
  ): Promise<WorkflowResultType<T>> {
    return super.execute(workflowTypeOrFunc, options);
  }

  /**
   * Gets the result of a Workflow execution.
   *
   * @see {@link BaseWorkflowClient.result}
   */
  override async result<T>(
    workflowId: string,
    runId?: string | undefined,
    opts?: WorkflowResultOptions | undefined
  ): Promise<T> {
    if (opts?.runInNormalTime) {
      return await super.result(workflowId, runId, opts);
    }
    await this.testService.unlockTimeSkipping({});
    try {
      return await super.result(workflowId, runId, opts);
    } finally {
      await this.testService.lockTimeSkipping({});
    }
  }
}

/**
 * Convenience workflow interceptors
 *
 * Contains a single interceptor for transforming `AssertionError`s into non
 * retryable `ApplicationFailure`s.
 */
export const workflowInterceptorModules = [path.join(__dirname, 'assert-to-failure-interceptor')];

export interface TestServerSpawnerOptions {
  /**
   * @default {@link DEFAULT_TEST_SERVER_PATH}
   */
  path?: string;
  /**
   * @default ignore
   */
  stdio?: StdioOptions;
}

/**
 * A generic callback that returns a child process
 */
export type TestServerSpawner = (port: number) => ChildProcess;

/**
 * Options for {@link TestWorkflowEnvironment.create}
 */
export interface TestWorkflowEnvironmentOptions {
  testServer?: TestServerSpawner | TestServerSpawnerOptions;
  logger?: Logger;
}

interface TestWorkflowEnvironmentOptionsWithDefaults {
  testServerSpawner: TestServerSpawner;
  logger: Logger;
}

function addDefaults({
  testServer,
  logger,
}: TestWorkflowEnvironmentOptions): TestWorkflowEnvironmentOptionsWithDefaults {
  return {
    testServerSpawner:
      typeof testServer === 'function'
        ? testServer
        : (port: number) =>
            spawn(testServer?.path || DEFAULT_TEST_SERVER_PATH, [`${port}`], {
              stdio: testServer?.stdio || 'ignore',
            }),
    logger: logger ?? new DefaultLogger('INFO'),
  };
}

// TS transforms `import` statements into `require`s, this is a workaround until
// tsconfig module nodenext is stable.
const _importDynamic = new Function('modulePath', 'return import(modulePath)');

/**
 * An execution environment for running Workflow integration tests.
 *
 * Runs an external server.
 * By default, the Java test server is used which supports time skipping.
 */
export class TestWorkflowEnvironment {
  /**
   * Get an extablished {@link Connection} to the test server
   */
  public readonly connection: Connection;

  /**
   * An {@link AsyncCompletionClient} for interacting with the test server
   */
  public readonly asyncCompletionClient: AsyncCompletionClient;

  /**
   * A {@link WorkflowClient} for interacting with the test server
   */
  public readonly workflowClient: WorkflowClient;

  /**
   * A {@link NativeConnection} for interacting with the test server.
   *
   * Use this connection when creating Workers for testing.
   */
  public readonly nativeConnection: NativeConnection;

  protected constructor(
    protected readonly serverProc: ChildProcess,
    connection: Connection,
    nativeConnection: NativeConnection
  ) {
    this.connection = connection;
    this.nativeConnection = nativeConnection;
    this.workflowClient = new WorkflowClient(this.connection);
    this.asyncCompletionClient = new AsyncCompletionClient(this.connection);
  }

  /**
   * Create a new test environment
   */
  static async create(opts?: TestWorkflowEnvironmentOptions): Promise<TestWorkflowEnvironment> {
    // No, we're not going to compile this to ESM for one dependency
    const getPort = (await _importDynamic('get-port')).default as typeof getPortType;
    const port = await getPort();

    const { testServerSpawner, logger } = addDefaults(opts ?? {});

    const child = testServerSpawner(port);

    const address = `127.0.0.1:${port}`;
    const connPromise = Connection.create({ address });

    try {
      await Promise.race([
        connPromise,
        waitOnChild(child).then(() => {
          throw new Error('Test server child process exited prematurely');
        }),
      ]);
    } catch (err) {
      try {
        await kill(child);
      } catch (error) {
        logger.error('Failed to kill test server child process', { error });
      }
      throw err;
    }

    const conn = await connPromise;
    const nativeConnection = await NativeConnection.create({ address });

    return new this(child, conn, nativeConnection);
  }

  /**
   * Kill the test server process and close the connection to it
   */
  async teardown(): Promise<void> {
    this.connection.client.close();
    // TODO: the server should return exit code 0
    await kill(this.serverProc, 'SIGINT', { validReturnCodes: [0, 130] });
  }

  /**
   * Wait for `durationMs` in "test server time".
   *
   * The test server toggles between skipped time and normal time depending on what it needs to execute.
   *
   * This method is likely to resolve in less than `durationMs` of "real time".
   *
   * Useful for simulating events far into the future like completion of long running activities.
   *
   * @param durationMs {@link https://www.npmjs.com/package/ms | ms} formatted string or number of milliseconds
   *
   * @example
   *
   * `workflow.ts`
   *
   * ```ts
   * const activities = proxyActivities({ startToCloseTimeout: 2_000_000 });
   *
   * export async function raceActivityAndTimer(): Promise<string> {
   *   return await Promise.race([
   *     wf.sleep(500_000).then(() => 'timer'),
   *     activities.longRunning().then(() => 'activity'),
   *   ]);
   * }
   * ```
   *
   * `test.ts`
   *
   * ```ts
   * const worker = await Worker.create({
   *   connection: testEnv.nativeConnection,
   *   activities: {
   *     async longRunning() {
   *       await testEnv.sleep(1_000_000); // <-- sleep called here
   *     },
   *   },
   *   // ...
   * });
   * ```
   */
  sleep = async (durationMs: number | string): Promise<void> => {
    await this.connection.testService.unlockTimeSkippingWithSleep({ duration: msToTs(durationMs) });
  };
}

/**
 * Used as the default activity info for Activities executed in the {@link MockActivityEnvironment}
 */
export const defaultActivityInfo: activity.Info = {
  attempt: 1,
  isLocal: false,
  taskToken: Buffer.from('test'),
  activityId: 'test',
  activityType: 'unknown',
  workflowType: 'test',
  base64TaskToken: Buffer.from('test').toString('base64'),
  heartbeatDetails: undefined,
  activityNamespace: 'default',
  workflowNamespace: 'default',
  workflowExecution: { workflowId: 'test', runId: 'dead-beef' },
  scheduledTimestampMs: 1,
  startToCloseTimeoutMs: 1000,
  scheduleToCloseTimeoutMs: 1000,
};

/**
 * An execution environment for testing Activities.
 *
 * Mocks Activity {@link Context | activity.Context} and exposes hooks for
 * cancellation and heartbeats.
 */
export class MockActivityEnvironment extends events.EventEmitter {
  public cancel: (reason?: any) => void = () => undefined;
  public readonly context: activity.Context;

  constructor(info?: Partial<activity.Info>) {
    super();
    const abortController = new AbortController();
    const promise = new Promise<never>((_, reject) => {
      this.cancel = (reason?: any) => {
        abortController.abort();
        reject(new CancelledFailure(reason));
      };
    });
    const heartbeatCallback = (details?: unknown) => this.emit('heartbeat', details);
    this.context = new activity.Context(
      { ...defaultActivityInfo, ...info },
      promise,
      abortController.signal,
      heartbeatCallback
    );
  }

  /**
   * Run a function in Activity Context
   */
  public run<P extends any[], R, F extends ActivityFunction<P, R>>(fn: F, ...args: P): Promise<R> {
    return activity.asyncLocalStorage.run(this.context, fn, ...args);
  }
}
