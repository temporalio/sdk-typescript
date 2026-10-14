import path from 'path';
import { randomUUID } from 'crypto';
import * as grpc from '@grpc/grpc-js';
import asyncRetry from 'async-retry';
import type { ConnectionLike, WorkflowClient } from '@temporalio/client';
import { Client, isGrpcServiceError, ServiceError } from '@temporalio/client';
import * as iface from '@temporalio/proto';
import {
  createBaseBundlerOptions,
  defaultSAKeys,
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

// Some of our tests expect "default custom search attributes" to exist, which used to be the case in all deployments
// with support for advanced visibility. However, this might no longer be true in some environments (e.g. an existing
// Temporal CLI dev server). Use the operator service to create them if they're missing. On Temporal Cloud, the
// operator service is unavailable; CI creates them along with the namespace (see .github/scripts/cloud-namespace.ts).
export async function registerDefaultCustomSearchAttributes(
  connection: ConnectionLike,
  namespace: string
): Promise<void> {
  const client = new Client({ connection, namespace }).workflow;
  if (await defaultCustomSearchAttributesAreUsable(client)) return;

  console.log(`Registering custom search attributes in namespace ${namespace}...`);
  const startTime = Date.now();
  try {
    await connection.operatorService.addSearchAttributes({
      namespace,
      searchAttributes: Object.fromEntries(
        Object.values(defaultSAKeys).map(({ name, type }) => [
          name,
          iface.temporal.api.enums.v1.IndexedValueType[`INDEXED_VALUE_TYPE_${type}`],
        ])
      ),
    });
  } catch (err) {
    if (!(isGrpcServiceError(err) && err.code === grpc.status.ALREADY_EXISTS)) {
      throw new Error(`Failed to register default custom search attributes in namespace ${namespace}`, {
        cause: err,
      });
    }
  }
  // The initialization of the custom search attributes is slooooow. Wait for it to finish
  await asyncRetry(
    async (bail) => {
      let usable: boolean;
      try {
        usable = await defaultCustomSearchAttributesAreUsable(client);
      } catch (err) {
        bail(err as Error);
        return;
      }
      if (!usable) throw new Error(`Default custom search attributes are not yet usable in namespace ${namespace}`);
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
 * Try to start a Workflow that sets a default custom search attribute.
 *
 * The start fails immediately if the attribute is not registered. Otherwise, the Workflow is terminated right away;
 * no Worker polls its task queue.
 */
async function defaultCustomSearchAttributesAreUsable(client: WorkflowClient): Promise<boolean> {
  try {
    const handle = await client.start('wait-for-default-custom-search-attributes', {
      workflowId: randomUUID(),
      taskQueue: `default-custom-search-attributes-probe-${randomUUID()}`,
      workflowExecutionTimeout: 1000,
      searchAttributes: { CustomIntField: [1] },
    });
    await handle.terminate();
    return true;
  } catch (err) {
    if (err instanceof ServiceError && isGrpcServiceError(err.cause) && err.cause.details.includes('CustomIntField')) {
      return false;
    }
    throw err;
  }
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
