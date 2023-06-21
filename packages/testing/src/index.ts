/**
 * `npm i @temporalio/testing`
 *
 * Testing library for the SDK.
 *
 * [Documentation](https://docs.temporal.io/typescript/testing)
 *
 * @module
 */

import 'abort-controller/polyfill'; // eslint-disable-line import/no-unassigned-import
import path from 'node:path';
import events from 'node:events';
import * as activity from '@temporalio/activity';
import {
  AsyncCompletionClient,
  Client,
  ClientOptions,
  WorkflowClient,
  WorkflowClientOptions,
  WorkflowResultOptions,
} from '@temporalio/client';
import { ActivityFunction, CancelledFailure, Duration } from '@temporalio/common';
import { msToNumber, msToTs, tsToMs } from '@temporalio/common/lib/time';
import { NativeConnection, Runtime } from '@temporalio/worker';
import {
  EphemeralServer,
  EphemeralServerConfig,
  getEphemeralServerTarget,
  DevServerConfig,
  TimeSkippingServerConfig,
} from '@temporalio/core-bridge';
import { filterNullAndUndefined } from '@temporalio/common/lib/internal-non-workflow';
import { Connection, TestService } from './connection';

export { TimeSkippingServerConfig, DevServerConfig, EphemeralServerExecutable } from '@temporalio/core-bridge';
export { EphemeralServerConfig };

export interface TimeSkippingWorkflowClientOptions extends WorkflowClientOptions {
  connection: Connection;
  enableTimeSkipping: boolean;
}

export interface TestEnvClientOptions extends ClientOptions {
  connection: Connection;
  enableTimeSkipping: boolean;
}

/**
 * A client with the exact same API as the "normal" client with 1 exception,
 * When this client waits on a Workflow's result, it will enable time skipping
 * in the test server.
 */
export class TimeSkippingWorkflowClient extends WorkflowClient {
  protected readonly testService: TestService;
  protected readonly enableTimeSkipping: boolean;

  constructor(options: TimeSkippingWorkflowClientOptions) {
    super(options);
    this.enableTimeSkipping = options.enableTimeSkipping;
    this.testService = options.connection.testService;
  }

  /**
   * Gets the result of a Workflow execution.
   *
   * @see {@link WorkflowClient.result}
   */
  override async result<T>(
    workflowId: string,
    runId?: string | undefined,
    opts?: WorkflowResultOptions | undefined
  ): Promise<T> {
    if (this.enableTimeSkipping) {
      await this.testService.unlockTimeSkipping({});
      try {
        return await super.result(workflowId, runId, opts);
      } finally {
        await this.testService.lockTimeSkipping({});
      }
    } else {
      return await super.result(workflowId, runId, opts);
    }
  }
}

/**
 * A client with the exact same API as the "normal" client with one exception:
 * when `TestEnvClient.workflow` (an instance of {@link TimeSkippingWorkflowClient}) waits on a Workflow's result, it will enable time skipping
 * in the Test Server.
 */
class TestEnvClient extends Client {
  constructor(options: TestEnvClientOptions) {
    super(options);

    // Recreate the client (this isn't optimal but it's better than adding public methods just for testing).
    // NOTE: we cast to "any" to work around `workflow` being a readonly attribute.
    (this as any).workflow = new TimeSkippingWorkflowClient({
      ...this.workflow.options,
      connection: options.connection,
      enableTimeSkipping: options.enableTimeSkipping,
    });
  }
}

/**
 * Convenience workflow interceptors
 *
 * Contains a single interceptor for transforming `AssertionError`s into non
 * retryable `ApplicationFailure`s.
 */
export const workflowInterceptorModules = [path.join(__dirname, 'assert-to-failure-interceptor')];

/**
 * Subset of the "normal" client options that are used to create a client for the test environment.
 */
export type ClientOptionsForTestEnv = Omit<ClientOptions, 'namespace' | 'connection'>;

/**
 * Options for {@link TestWorkflowEnvironment.create}
 */
export type TestWorkflowEnvironmentOptions = {
  server: EphemeralServerConfig;
  client?: ClientOptionsForTestEnv;
};

/**
 * Options for {@link TestWorkflowEnvironment.createTimeSkipping}
 */
export type TimeSkippingTestWorkflowEnvironmentOptions = {
  server?: Omit<TimeSkippingServerConfig, 'type'>;
  client?: ClientOptionsForTestEnv;
};

/**
 * Options for {@link TestWorkflowEnvironment.createLocal}
 */
export type LocalTestWorkflowEnvironmentOptions = {
  server?: Omit<DevServerConfig, 'type'>;
  client?: ClientOptionsForTestEnv;
};

export type TestWorkflowEnvironmentOptionsWithDefaults = Required<TestWorkflowEnvironmentOptions>;

function addDefaults(opts: TestWorkflowEnvironmentOptions): TestWorkflowEnvironmentOptionsWithDefaults {
  return {
    client: {},
    ...opts,
  };
}

/**
 * An execution environment for running Workflow integration tests.
 *
 * Runs an external server.
 * By default, the Java test server is used which supports time skipping.
 */
export class TestWorkflowEnvironment {
  /**
   * Namespace used in this environment (taken from {@link TestWorkflowEnvironmentOptions})
   */
  public readonly namespace?: string;
  /**
   * Get an established {@link Connection} to the ephemeral server
   */
  public readonly connection: Connection;

  /**
   * A {@link TestEnvClient} for interacting with the ephemeral server
   */
  public readonly client: Client;

  /**
   * An {@link AsyncCompletionClient} for interacting with the test server
   *
   * @deprecated - use `client.activity` instead
   */
  public readonly asyncCompletionClient: AsyncCompletionClient;

  /**
   * A {@link TimeSkippingWorkflowClient} for interacting with the test server
   *
   * @deprecated - use `client.workflow` instead
   */
  public readonly workflowClient: WorkflowClient;

  /**
   * A {@link NativeConnection} for interacting with the test server.
   *
   * Use this connection when creating Workers for testing.
   */
  public readonly nativeConnection: NativeConnection;

  protected constructor(
    public readonly options: TestWorkflowEnvironmentOptionsWithDefaults,
    public readonly supportsTimeSkipping: boolean,
    protected readonly server: EphemeralServer,
    connection: Connection,
    nativeConnection: NativeConnection,
    namespace: string | undefined
  ) {
    this.connection = connection;
    this.nativeConnection = nativeConnection;
    this.namespace = namespace;
    this.client = new TestEnvClient({
      connection,
      namespace: this.namespace,
      enableTimeSkipping: supportsTimeSkipping,
      ...options.client,
    });
    // eslint-disable-next-line deprecation/deprecation
    this.asyncCompletionClient = this.client.activity;
    // eslint-disable-next-line deprecation/deprecation
    this.workflowClient = this.client.workflow;
  }

  /**
   * Start a time skipping workflow environment.
   *
   * By default, this environment will automatically skip to the next events in time when a workflow handle's `result`
   * is awaited on (which includes {@link WorkflowClient.execute}). Before the result is awaited on, time can be
   * manually skipped forward using {@link sleep}. The currently known time can be obtained via {@link currentTimeMs}.
   *
   * Internally, this environment lazily downloads a test-server binary for the current OS/arch from the [Java SDK
   * releases](https://github.com/temporalio/sdk-java/releases) into the temp directory if it is not already there.
   * Then the executable is started and will be killed when {@link teardown} is called.
   *
   * Users can reuse this environment for testing multiple independent workflows, but not concurrently. Time skipping,
   * which is automatically done when awaiting a workflow result and manually done on sleep, is global to the
   * environment, not to the workflow under test.
   *
   * We highly recommend, running tests serially when using a single environment or creating a separate environment per
   * test.
   *
   * In the future, the test server implementation may be changed to another implementation.
   */
  static async createTimeSkipping(opts?: TimeSkippingTestWorkflowEnvironmentOptions): Promise<TestWorkflowEnvironment> {
    return await this.create({
      server: { type: 'time-skipping', ...opts?.server },
      client: opts?.client,
      supportsTimeSkipping: true,
    });
  }

  /**
   * Start a full Temporal server locally, downloading if necessary.
   *
   * This environment is good for testing full server capabilities, but does not support time skipping like
   * {@link createTimeSkipping} does. {@link supportsTimeSkipping} will always return `false` for this environment.
   * {@link sleep} will sleep the actual amount of time and {@link currentTimeMs} will return the current time.
   *
   * This local environment will be powered by [Temporal CLI](https://github.com/temporalio/cli), which is a
   * self-contained executable for Temporal. By default, Temporal's database will not be persisted to disk, and no UI
   * will be started.
   *
   * The CLI executable will be downloaded and cached to a temporary directory. See
   * {@link LocalTestWorkflowEnvironmentOptions.server.executable.type} if you'd prefer to provide the CLI executable
   * yourself.
   */
  static async createLocal(opts?: LocalTestWorkflowEnvironmentOptions): Promise<TestWorkflowEnvironment> {
    // eslint-disable-next-line deprecation/deprecation
    return await this.create({
      server: { type: 'dev-server', ...opts?.server },
      client: opts?.client,
      namespace: opts?.server?.namespace,
      supportsTimeSkipping: false,
    });
  }

  /**
   * Create a new test environment
   */
  private static async create(
    opts: TestWorkflowEnvironmentOptions & {
      supportsTimeSkipping: boolean;
      namespace?: string;
    }
  ): Promise<TestWorkflowEnvironment> {
    const { supportsTimeSkipping, namespace, ...rest } = opts;
    const optsWithDefaults = addDefaults(filterNullAndUndefined(rest));
    const server = await Runtime.instance().createEphemeralServer(optsWithDefaults.server);
    const address = getEphemeralServerTarget(server);

    const nativeConnection = await NativeConnection.connect({ address });
    const connection = await Connection.connect({ address });

    return new this(optsWithDefaults, supportsTimeSkipping, server, connection, nativeConnection, namespace);
  }

  /**
   * Kill the test server process and close the connection to it
   */
  async teardown(): Promise<void> {
    await this.connection.close();
    await this.nativeConnection.close();
    await Runtime.instance().shutdownEphemeralServer(this.server);
  }

  /**
   * Wait for `durationMs` in "server time".
   *
   * This awaits using regular setTimeout in regular environments, or manually skips time in time-skipping environments.
   *
   * Useful for simulating events far into the future like completion of long running activities.
   *
   * **Time skippping**:
   *
   * The time skippping server toggles between skipped time and normal time depending on what it needs to execute.
   *
   * This method is _likely_ to resolve in less than `durationMs` of "real time".
   *
   * @param durationMs number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
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
  sleep = async (durationMs: Duration): Promise<void> => {
    if (this.supportsTimeSkipping) {
      await (this.connection as Connection).testService.unlockTimeSkippingWithSleep({ duration: msToTs(durationMs) });
    } else {
      await new Promise((resolve) => setTimeout(resolve, msToNumber(durationMs)));
    }
  };

  /**
   * Get the current time known to this environment.
   *
   * For non-time-skipping environments this is simply the system time. For time-skipping environments this is whatever
   * time has been skipped to.
   */
  async currentTimeMs(): Promise<number> {
    if (this.supportsTimeSkipping) {
      const { time } = await (this.connection as Connection).testService.getCurrentTime({});
      return tsToMs(time);
    } else {
      return Date.now();
    }
  }
}

/**
 * Used as the default activity info for Activities executed in the {@link MockActivityEnvironment}
 */
export const defaultActivityInfo: activity.Info = {
  attempt: 1,
  taskQueue: 'test',
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
      heartbeatCallback,
      Runtime.instance().logger
    );
    promise.catch(() => {
      /* avoid unhandled rejection */
    });
  }

  /**
   * Run a function in Activity Context
   */
  public run<P extends any[], R, F extends ActivityFunction<P, R>>(fn: F, ...args: P): Promise<R> {
    return activity.asyncLocalStorage.run(this.context, fn, ...args);
  }
}
