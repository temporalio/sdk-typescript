import path from 'path';
import * as grpc from '@grpc/grpc-js';
import asyncRetry from 'async-retry';
import { v4 as uuid4 } from 'uuid';
import { Client, Connection } from '@temporalio/client';
import * as iface from '@temporalio/proto';

// Re-export from test-helpers
export {
  sleep,
  waitUntil,
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
import {
  createBaseBundlerOptions,
  loadHistory as loadHistoryBase,
  saveHistory as saveHistoryBase,
} from '@temporalio/test-helpers';

/**
 * Package-specific bundler options that include local activity and mock-native-worker modules.
 */
export const bundlerOptions = createBaseBundlerOptions([
  require.resolve('./activities'),
  require.resolve('./mock-native-worker'),
]);

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
          workflowId: uuid4(),
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
