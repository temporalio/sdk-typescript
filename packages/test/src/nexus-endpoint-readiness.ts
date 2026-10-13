/**
 * Readiness check for Nexus endpoints that `.github/scripts/cloud-namespace.ts` creates for a Cloud test run.
 *
 * Cloud propagates endpoints through eventually consistent registry caches, and the Cloud Ops API cannot report
 * when that has finished. Like the Nexus team's own Cloud tests, call each endpoint from the target namespace until a
 * call succeeds, then wait a while longer for the remaining caches to refresh.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import * as nexus from 'nexus-rpc';
import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import type { LoadClientProfileOptions } from '@temporalio/envconfig';
import { loadClientConnectConfig } from '@temporalio/envconfig';
import { NativeConnection, Worker } from '@temporalio/worker';
import { nexusEndpointProbeCaller, nexusEndpointProbeService } from './workflows/nexus-endpoint-probe';

export interface NexusEndpointTarget {
  name: string;
  /** Task queue in the configured namespace that the endpoint routes to. */
  taskQueue: string;
}

const CALLER_TASK_QUEUE = 'nexus-endpoint-probe-caller';

// The Nexus team's test budget: retry every 200ms for up to 3 minutes, then wait 30 seconds once a call succeeds.
const READY_TIMEOUT_MS = 3 * 60_000;
const SETTLE_MS = 30_000;
const RETRY_DELAY_MS = 200;
// Bounds an attempt that never completes, e.g. while the caller's workflow task fails on an unknown endpoint.
const ATTEMPT_TIMEOUT = '15s';

async function callUntilReady(client: Client, endpointName: string): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + READY_TIMEOUT_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await client.workflow.execute(nexusEndpointProbeCaller, {
        taskQueue: CALLER_TASK_QUEUE,
        workflowId: `${endpointName}-${attempt}`,
        args: [endpointName, endpointName],
        workflowExecutionTimeout: ATTEMPT_TIMEOUT,
      });
      if (result !== endpointName) {
        throw new Error(`Nexus endpoint ${endpointName} echoed ${JSON.stringify(result)}`);
      }
      console.log(`Nexus endpoint ${endpointName} responded after ${Date.now() - startedAt}ms (${attempt} attempts)`);
      return;
    } catch (error) {
      if (!(error instanceof WorkflowFailedError)) throw error;
      if (Date.now() + RETRY_DELAY_MS >= deadline) {
        throw new Error(`Nexus endpoint ${endpointName} did not respond within ${READY_TIMEOUT_MS}ms`, {
          cause: error,
        });
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/**
 * Wait until every endpoint in `endpoints` routes calls from the configured namespace to its task queue.
 *
 * @param envconfigOpts - Selects the namespace and connection, as for the tests themselves.
 */
export async function waitForNexusEndpointsReady(
  envconfigOpts: LoadClientProfileOptions,
  endpoints: readonly NexusEndpointTarget[]
): Promise<void> {
  const { namespace, connectionOptions } = loadClientConnectConfig(envconfigOpts);
  const { address, apiKey, metadata, tls } = connectionOptions;
  const connection = await Connection.connect({ address, apiKey, metadata, tls });
  try {
    const nativeConnection = await NativeConnection.connect({ address, apiKey, metadata, tls });
    try {
      const echoHandler = nexus.serviceHandler(nexusEndpointProbeService, { echo: async (_ctx, input) => input });
      const workers = await Promise.all([
        Worker.create({
          connection: nativeConnection,
          namespace,
          taskQueue: CALLER_TASK_QUEUE,
          workflowsPath: require.resolve('./workflows/nexus-endpoint-probe'),
        }),
        // One handler worker per endpoint, each with a single poller to keep the number of open polls down.
        ...endpoints.map(({ taskQueue }) =>
          Worker.create({
            connection: nativeConnection,
            namespace,
            taskQueue,
            nexusServices: [echoHandler],
            nexusTaskPollerBehavior: { type: 'simple-maximum', maximum: 1 },
          })
        ),
      ]);
      const client = new Client({ connection, namespace });
      const probes = Promise.all(endpoints.map(({ name }) => callUntilReady(client, name)));
      // Let every worker shut down before reporting a failure and closing the connections.
      const results = await Promise.allSettled(workers.map((worker) => worker.runUntil(probes)));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
    } finally {
      await nativeConnection.close();
    }
  } finally {
    await connection.close();
  }

  console.log(`All ${endpoints.length} Nexus endpoints responded; waiting ${SETTLE_MS}ms for the remaining caches`);
  await sleep(SETTLE_MS);
}
