import 'abort-controller/polyfill'; // eslint-disable-line import/no-unassigned-import
import { AsyncCompletionClient, Client, WorkflowClient } from '@temporalio/client';
import { Duration, TypedSearchAttributes } from '@temporalio/common';
import { msToNumber, msToTs, tsToMs } from '@temporalio/common/lib/time';
import { NativeConnection, Runtime } from '@temporalio/worker';
import { native } from '@temporalio/core-bridge';
import { filterNullAndUndefined } from '@temporalio/common/lib/internal-workflow';
import { Connection } from './connection';
import { toNativeEphemeralServerConfig, DevServerConfig, TimeSkippingServerConfig } from './ephemeral-server';
import { ClientOptionsForTestEnv, TestEnvClient } from './client';

/**
 * Options for {@link TestWorkflowEnvironment.createLocal}
 */
export type LocalTestWorkflowEnvironmentOptions = {
  server?: Omit<DevServerConfig, 'type'>;
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
 * Options for {@link TestWorkflowEnvironment.createExistingServer}
 */
export type ExistingServerTestWorkflowEnvironmentOptions = {
  /** If not set, defaults to localhost:7233 */
  address?: string;
  /** If not set, defaults to default */
  namespace?: string;
  client?: ClientOptionsForTestEnv;
};

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
    private readonly runtime: Runtime,
    public readonly options: TestWorkflowEnvironmentOptionsWithDefaults,
    public readonly supportsTimeSkipping: boolean,
    protected readonly server: native.EphemeralServer | 'existing',
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
    this.asyncCompletionClient = this.client.activity; // eslint-disable-line deprecation/deprecation
    this.workflowClient = this.client.workflow; // eslint-disable-line deprecation/deprecation
  }

  /**
   * Start a time skipping workflow environment.
   *
   * This environment automatically skips to the next events in time when a workflow handle's `result` is awaited on
   * (which includes {@link WorkflowClient.execute}). Before the result is awaited on, time can be manually skipped
   * forward using {@link sleep}. The currently known time can be obtained via {@link currentTimeMs}.
   *
   * This environment will be powered by the Temporal Time Skipping Test Server (part of the [Java SDK](https://github.com/temporalio/sdk-java)).
   * Note that the Time Skipping Test Server does not support full capabilities of the regular Temporal Server, and may
   * occasionally present different behaviors. For general Workflow testing, it is generally preferable to use {@link createLocal}
   * instead.
   *
   * Users can reuse this environment for testing multiple independent workflows, but not concurrently. Time skipping,
   * which is automatically done when awaiting a workflow result and manually done on sleep, is global to the
   * environment, not to the workflow under test. We highly recommend running tests serially when using a single
   * environment or creating a separate environment per test.
   *
   * By default, the latest release of the Test Server will be downloaded and cached to a temporary directory
   * (e.g. `$TMPDIR/temporal-test-server-sdk-typescript-*` or `%TEMP%/temporal-test-server-sdk-typescript-*.exe`). Note
   * that existing cached binaries will be reused without validation that they are still up-to-date, until the SDK
   * itself is updated. Alternatively, a specific version number of the Test Server may be provided, or the path to an
   * existing Test Server binary may be supplied; see {@link LocalTestWorkflowEnvironmentOptions.server.executable}.
   *
   * Note that the Test Server implementation may be changed to another one in the future. Therefore, there is no
   * guarantee that Test Server options, and particularly those provided through the `extraArgs` array, will continue to
   * be supported in the future.
   *
   * IMPORTANT: At this time, the Time Skipping Test Server is not supported on ARM platforms. Execution on Apple
   * silicon Macs will work if Rosetta 2 is installed.
   */
  static async createTimeSkipping(opts?: TimeSkippingTestWorkflowEnvironmentOptions): Promise<TestWorkflowEnvironment> {
    return await this.create({
      server: { type: 'time-skipping', ...opts?.server },
      client: opts?.client,
      supportsTimeSkipping: true,
    });
  }

  /**
   * Start a full Temporal server locally.
   *
   * This environment is good for testing full server capabilities, but does not support time skipping like
   * {@link createTimeSkipping} does. {@link supportsTimeSkipping} will always return `false` for this environment.
   * {@link sleep} will sleep the actual amount of time and {@link currentTimeMs} will return the current time.
   *
   * This local environment will be powered by [Temporal CLI](https://github.com/temporalio/cli), which is a
   * self-contained executable for Temporal. By default, Temporal's database will not be persisted to disk, and no UI
   * will be launched.
   *
   * By default, the latest release of the CLI will be downloaded and cached to a temporary directory
   * (e.g. `$TMPDIR/temporal-sdk-typescript-*` or `%TEMP%/temporal-sdk-typescript-*.exe`). Note that existing cached
   * binaries will be reused without validation that they are still up-to-date, until the SDK itself is updated.
   * Alternatively, a specific version number of the CLI may be provided, or the path to an existing CLI binary may be
   * supplied; see {@link LocalTestWorkflowEnvironmentOptions.server.executable}.
   *
   * Note that the Dev Server implementation may be changed to another one in the future. Therefore, there is no
   * guarantee that Dev Server options, and particularly those provided through the `extraArgs` array, will continue to
   * be supported in the future.
   */
  static async createLocal(opts?: LocalTestWorkflowEnvironmentOptions): Promise<TestWorkflowEnvironment> {
    return await this.create({
      server: { type: 'dev-server', ...opts?.server },
      client: opts?.client,
      namespace: opts?.server?.namespace,
      supportsTimeSkipping: false,
    });
  }

  /**
   * Create a new test environment using an existing server. You must already be running a server, which the test
   * environment will connect to.
   */
  static async createFromExistingServer(
    opts?: ExistingServerTestWorkflowEnvironmentOptions
  ): Promise<TestWorkflowEnvironment> {
    return await this.create({
      server: { type: 'existing' },
      client: opts?.client,
      namespace: opts?.namespace ?? 'default',
      supportsTimeSkipping: false,
      address: opts?.address,
    });
  }

  /**
   * Create a new test environment
   */
  private static async create(
    opts: TestWorkflowEnvironmentOptions & {
      supportsTimeSkipping: boolean;
      namespace?: string;
      address?: string;
    }
  ): Promise<TestWorkflowEnvironment> {
    const { supportsTimeSkipping, namespace, ...rest } = opts;
    const optsWithDefaults = addDefaults(filterNullAndUndefined(rest));

    let address: string;
    const runtime = Runtime.instance();
    let server: native.EphemeralServer | 'existing';
    if (optsWithDefaults.server.type !== 'existing') {
      // Add search attributes to CLI server arguments
      if ('searchAttributes' in optsWithDefaults.server && optsWithDefaults.server.searchAttributes) {
        let newArgs: string[] = [];
        for (const { name, type } of optsWithDefaults.server.searchAttributes) {
          newArgs.push('--search-attribute');
          newArgs.push(`${name}=${TypedSearchAttributes.toMetadataType(type)}`);
        }
        newArgs = newArgs.concat(optsWithDefaults.server.extraArgs ?? []);
        optsWithDefaults.server.extraArgs = newArgs;
      }

      server = await runtime.createEphemeralServer(toNativeEphemeralServerConfig(optsWithDefaults.server));
      address = native.ephemeralServerGetTarget(server);
    } else {
      address = opts.address ?? 'localhost:7233';
      server = 'existing';
    }

    const nativeConnection = await NativeConnection.connect({ address });
    const connection = await Connection.connect({ address });

    return new this(runtime, optsWithDefaults, supportsTimeSkipping, server, connection, nativeConnection, namespace);
  }

  /**
   * Kill the test server process and close the connection to it
   */
  async teardown(): Promise<void> {
    await this.connection.close().catch((e) => {
      console.error(e);
      /* ignore */
    });
    await this.nativeConnection.close().catch((e) => {
      console.error(e);
      /* ignore */
    });
    if (this.server !== 'existing') {
      await this.runtime.shutdownEphemeralServer(this.server).catch((e) => {
        console.error(e);
        /* ignore */
      });
    }
  }

  /**
   * Wait for `durationMs` in "server time".
   *
   * This awaits using regular setTimeout in regular environments or manually skips time in time-skipping environments.
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
 * Options for {@link TestWorkflowEnvironment.create}
 */
type TestWorkflowEnvironmentOptions = {
  server: DevServerConfig | TimeSkippingServerConfig | ExistingServerConfig;
  client?: ClientOptionsForTestEnv;
};

type ExistingServerConfig = { type: 'existing' };

type TestWorkflowEnvironmentOptionsWithDefaults = Required<TestWorkflowEnvironmentOptions>;

function addDefaults(opts: TestWorkflowEnvironmentOptions): TestWorkflowEnvironmentOptionsWithDefaults {
  return {
    client: {},
    ...opts,
    server: {
      ...opts.server,
    },
  };
}
