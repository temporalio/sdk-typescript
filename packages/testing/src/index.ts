/**
 * `npm i @temporalio/testing`
 *
 * Testing library for the SDK.
 *
 * [Documentation](https://docs.temporal.io/typescript/testing)
 *
 * @module
 */

import * as activity from '@temporalio/activity';
import {
  AsyncCompletionClient,
  WorkflowClient as BaseWorkflowClient,
  WorkflowClientOptions as BaseWorkflowClientOptions,
  WorkflowResultOptions,
} from '@temporalio/client';
import { ActivityFunction, CancelledFailure, msToTs } from '@temporalio/common';
import { NativeConnection, Runtime } from '@temporalio/worker';
import { EphemeralServer, EphemeralServerConfig, getEphemeralServerTarget } from '@temporalio/core-bridge';
import path from 'path';
import { AbortController } from 'abort-controller';
import events from 'events';
import { Connection, TestService } from './test-service-client';
import { filterNullAndUndefined } from '@temporalio/internal-non-workflow-common';
import ms from 'ms';

export { TimeSkippingServerConfig, TemporaliteConfig, EphemeralServerExecutable } from '@temporalio/core-bridge';
export { EphemeralServerConfig };

export interface WorkflowClientOptions extends BaseWorkflowClientOptions {
  connection: Connection;
  enableTimeSkipping: boolean;
}

/**
 * A client with the exact same API as the "normal" client with 1 exception,
 * When this client waits on a Workflow's result, it will enable time skipping
 * in the test server.
 */
export class WorkflowClient extends BaseWorkflowClient {
  protected readonly testService: TestService;
  protected readonly enableTimeSkipping: boolean;

  constructor(options: WorkflowClientOptions) {
    super(options);
    this.enableTimeSkipping = options.enableTimeSkipping;
    this.testService = options.connection.testService;
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
 * Convenience workflow interceptors
 *
 * Contains a single interceptor for transforming `AssertionError`s into non
 * retryable `ApplicationFailure`s.
 */
export const workflowInterceptorModules = [path.join(__dirname, 'assert-to-failure-interceptor')];

/**
 * Options for {@link TestWorkflowEnvironment.create}
 */
type TestWorkflowEnvironmentOptions = Partial<EphemeralServerConfig>;

type TestWorkflowEnvironmentOptionsWithDefaults = EphemeralServerConfig;

function addDefaults(opts: TestWorkflowEnvironmentOptions): TestWorkflowEnvironmentOptionsWithDefaults {
  return {
    type: 'time-skipping',
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
    public readonly options: TestWorkflowEnvironmentOptionsWithDefaults,
    protected readonly server: EphemeralServer,
    connection: Connection,
    nativeConnection: NativeConnection
  ) {
    this.connection = connection;
    this.nativeConnection = nativeConnection;
    this.namespace = options.type === 'temporalite' ? options.namespace : undefined;
    this.workflowClient = new WorkflowClient({
      connection,
      namespace: this.namespace,
      enableTimeSkipping: options.type === 'time-skipping',
    });
    this.asyncCompletionClient = new AsyncCompletionClient({ connection, namespace: this.namespace });
  }

  /**
   * Create a new test environment
   */
  static async create(opts?: TestWorkflowEnvironmentOptions): Promise<TestWorkflowEnvironment> {
    const optsWithDefaults = addDefaults(filterNullAndUndefined(opts ?? {}));
    const server = await Runtime.instance().createEphemeralServer(optsWithDefaults);
    const address = getEphemeralServerTarget(server);

    const nativeConnection = await NativeConnection.connect({ address });
    const connection = await Connection.connect({ address });

    return new this(optsWithDefaults, server, connection, nativeConnection);
  }

  /**
   * Kill the test server process and close the connection to it
   */
  async teardown(): Promise<void> {
    await this.connection.close();
    await this.nativeConnection.close();
    // TODO: the server should return exit code 0
    await Runtime.instance().shutdownEphemeralServer(this.server);
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
    if (this.options.type === 'time-skipping') {
      await this.connection.testService.unlockTimeSkippingWithSleep({ duration: msToTs(durationMs) });
    } else {
      await new Promise((resolve) => setTimeout(resolve, typeof durationMs === 'string' ? ms(durationMs) : durationMs));
    }
  };
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
      heartbeatCallback
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
