import * as activity from '@temporalio/activity';
import { AsyncCompletionClient, Connection, WorkflowClient } from '@temporalio/client';
import { ActivityFunction, CancelledFailure } from '@temporalio/common';
import { Core } from '@temporalio/worker';
import path from 'path';
import { AbortController } from 'abort-controller';
import { ChildProcess, spawn } from 'child_process';
import events from 'events';
import { kill, waitOnChild } from './child-process';
import type getPortType from 'get-port';

/**
 * Options for {@link TestWorkflowEnvironment.create}
 */
interface TestWorkflowEnvironmentOptions {
  testServerSpawner?(port: number): ChildProcess;
}

function defaultTestWorkflowEnvironmentOptions(): Required<TestWorkflowEnvironmentOptions> {
  return {
    testServerSpawner(port: number) {
      return spawn(path.join(__dirname, '../test-server'), [`${port}`], {
        stdio: 'ignore',
      });
    },
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
  protected constructor(protected readonly serverProc: ChildProcess, protected readonly conn: Connection) {}

  /**
   * Create a new test environment
   */
  static async create(opts?: TestWorkflowEnvironmentOptions) {
    // No, we're not going to compile this to ESM for one dependency
    const getPort = (await _importDynamic('get-port')).default as typeof getPortType;
    const port = await getPort();

    const { testServerSpawner } = { ...defaultTestWorkflowEnvironmentOptions(), ...opts };

    const child = testServerSpawner(port);

    const address = `127.0.0.1:${port}`;
    const conn = new Connection({ address });

    try {
      await Promise.race([
        conn.untilReady(),
        waitOnChild(child).then(() => {
          throw new Error('Child exited prematurely');
        }),
      ]);
    } catch (err) {
      await kill(child);
      throw err;
    }

    // TODO: Core is a singleton at the moment, once the bridge is refactored this will change.
    await Core.install({ serverOptions: { address } });

    return new this(child, conn);
  }

  /**
   * Get an extablished {@link Connection} to the test server
   */
  get connection(): Connection {
    return this.conn;
  }

  /**
   * Get an {@link AsyncCompletionClient} for interacting with the test server
   */
  get asyncCompletionClient(): AsyncCompletionClient {
    return new AsyncCompletionClient(this.conn.service);
  }

  /**
   * Get a {@link WorkflowClient} for interacting with the test server
   */
  get workflowClient(): WorkflowClient {
    return new WorkflowClient(this.conn.service);
  }

  /**
   * Kill the test server process
   */
  async teardown() {
    this.conn.client.close();
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
