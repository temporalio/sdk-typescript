import * as activity from '@temporalio/activity';
import { AsyncCompletionClient, Connection, WorkflowClient } from '@temporalio/client';
import { ActivityFunction, CancelledFailure } from '@temporalio/common';
import { NativeConnection, Logger, DefaultLogger } from '@temporalio/worker';
import path from 'path';
import os from 'os';
import { AbortController } from 'abort-controller';
import { ChildProcess, spawn, StdioOptions } from 'child_process';
import events from 'events';
import { kill, waitOnChild } from './child-process';
import type getPortType from 'get-port';

const TEST_SERVER_EXECUTABLE_NAME = os.platform() === 'win32' ? 'test-server.exe' : 'test-server';

/**
 * Options for {@link TestWorkflowEnvironment.create}
 */
export interface TestWorkflowEnvironmentOptions {
  /**
   * If `testServerSpawner` is not provided, use this value for child process stdio
   */
  testServerStdio?: StdioOptions;
  testServerSpawner?(port: number): ChildProcess;
  logger?: Logger;
}

function addDefaults({
  testServerStdio = 'ignore',
  testServerSpawner,
  logger,
}: TestWorkflowEnvironmentOptions): Required<TestWorkflowEnvironmentOptions> {
  return {
    testServerSpawner:
      testServerSpawner ??
      ((port: number) =>
        spawn(path.join(__dirname, `../${TEST_SERVER_EXECUTABLE_NAME}`), [`${port}`], {
          stdio: testServerStdio,
        })),
    logger: logger ?? new DefaultLogger('INFO'),
    testServerStdio,
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
    this.workflowClient = new WorkflowClient(this.connection.service);
    this.asyncCompletionClient = new AsyncCompletionClient(this.connection.service);
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
    const conn = new Connection({ address });

    try {
      await Promise.race([
        conn.untilReady(),
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
}

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
