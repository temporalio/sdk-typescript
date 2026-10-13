import path from 'path';
import { randomUUID } from 'crypto';
import * as grpc from '@grpc/grpc-js';
import asyncRetry from 'async-retry';
import type { Connection } from '@temporalio/client';
import { Client } from '@temporalio/client';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import type { NativeConnectionOptions, WorkerOptions } from '@temporalio/worker';
import { InternalNativeConnection } from '@temporalio/worker/lib/connection';
import * as iface from '@temporalio/proto';
import {
  createBaseBundlerOptions,
  isSet,
  Worker,
  loadHistory as loadHistoryBase,
  saveHistory as saveHistoryBase,
  RUN_TIME_SKIPPING_TESTS,
  test,
  noopTest,
} from '@temporalio/test-helpers';

// Re-export from test-helpers
export {
  sleep,
  waitUntil,
  assertEventually,
  u8,
  approximatelyEqual,
  RUN_INTEGRATION_TESTS,
  REUSE_V8_CONTEXT,
  RUN_TIME_SKIPPING_TESTS,
  cleanStackTrace,
  cleanOptionalStackTrace,
  compareStackTrace,
  getRandomPort,
  ByteSkewerPayloadCodec,
  test,
  noopTest,
  Worker,
  TestWorkflowEnvironment,
  baseBundlerIgnoreModules,
  isBun,
} from '@temporalio/test-helpers';

export const testTimeSkipping = RUN_TIME_SKIPPING_TESTS ? test : noopTest;

/**
 * Package-specific bundler options that include local activity and mock-native-worker modules.
 */
export const bundlerOptions = createBaseBundlerOptions([
  require.resolve('./activities'),
  require.resolve('./mock-native-worker'),
]);

/**
 * Server connection settings for tests that must own their connections instead of using a shared test environment.
 *
 * Chosen like `createTestWorkflowEnvironment()`, but never starts a server: envconfig when
 * `TEMPORAL_TEST_ENV_CONFIG_SERVER` is set (e.g. on Cloud), otherwise `TEMPORAL_SERVICE_ADDRESS` or the default
 * local address, in the `default` namespace.
 */
export function ownedConnectionConfig(): { namespace: string; connectionOptions: NativeConnectionOptions } {
  if (isSet(process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER, false)) {
    const { namespace, connectionOptions } = loadClientConnectConfig();
    return { namespace: namespace ?? 'default', connectionOptions };
  }
  return { namespace: 'default', connectionOptions: { address: process.env.TEMPORAL_SERVICE_ADDRESS } };
}

/**
 * Create a Worker on a connection that the Worker owns and closes when it shuts down.
 *
 * Once the last such Worker stops, the Runtime shuts down too; a shared test environment would keep it alive.
 */
export async function createWorkerWithOwnConnection(
  options: Omit<WorkerOptions, 'connection' | 'namespace'> & Partial<Pick<WorkerOptions, 'namespace'>>
): ReturnType<typeof Worker.create> {
  const { namespace, connectionOptions } = ownedConnectionConfig();
  const connection = await InternalNativeConnection.connect(connectionOptions);
  try {
    return await Worker.create({ connection, namespace, ...options });
  } catch (err) {
    await connection.close();
    throw err;
  }
}

/**
 * A task queue name unique to this test run, so tests sharing a server or namespace never poll each other's tasks.
 */
export function uniqueTaskQueue(title: string): string {
  return `${title.replace(/[^a-zA-Z0-9]+/g, '-')}-${randomUUID()}`;
}

// Some of our tests expect "default custom search attributes" to exists, which used to be the case
// in all deployment with support for advanced visibility. However, this might no longer be true in
// some environement (e.g. Temporal CLI). Use the operator service to create them if they're missing.
export async function registerDefaultCustomSearchAttributes(connection: Connection): Promise<void> {
  const client = new Client({ connection }).workflow;
  console.log(`Registering custom search attributes...`);
  const startTime = Date.now();
  try {
    await connection.operatorService.addSearchAttributes({
      namespace: 'default',
      searchAttributes: {
        CustomIntField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_INT,
        CustomBoolField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_BOOL,
        CustomKeywordField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
        CustomTextField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_TEXT,
        CustomDatetimeField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_DATETIME,
        CustomDoubleField: iface.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_DOUBLE,
      },
    });
  } catch (err: any) {
    if (err.code !== grpc.status.ALREADY_EXISTS) {
      throw err;
    }
  }
  // The initialization of the custom search attributes is slooooow. Wait for it to finish
  await asyncRetry(
    async () => {
      try {
        // We simply _try_ to schedule a workflow that uses some custom search attributes.
        // The call will fail immediately if the SA are not registered yet. Note that the workflow
        // will actually never execute (ie. no worker is listing to that queue and workflow type
        // doesn't exist). It will just end up being terminated because of a timeout.
        const handle = await client.start('wait-for-default-custom-search-attributes', {
          workflowId: randomUUID(),
          taskQueue: 'no_one_cares_pointless_queue',
          workflowExecutionTimeout: 1000,
          searchAttributes: { CustomIntField: [1] },
        });
        await handle.terminate();
      } catch (e: any) {
        // Continue until we see an error that *isn't* about the SA being invalid
        if (!e.cause.details.includes('CustomIntField')) {
          return;
        }
        throw e;
      }
    },
    {
      retries: 60,
      maxTimeout: 1000,
    }
  );
  const timeTaken = Date.now() - startTime;
  console.log(`... Registered (took ${timeTaken / 1000} sec)!`);
}

/**
 * Load a history file from the history_files directory.
 */
export async function loadHistory(fname: string): Promise<iface.temporal.api.history.v1.History> {
  const fpath = path.resolve(__dirname, `../history_files/${fname}`);
  return loadHistoryBase(fpath);
}

/**
 * Save a history file to the history_files directory.
 */
export async function saveHistory(fname: string, history: iface.temporal.api.history.v1.IHistory): Promise<void> {
  const fpath = path.resolve(__dirname, `../history_files/${fname}`);
  return saveHistoryBase(fpath, history);
}
