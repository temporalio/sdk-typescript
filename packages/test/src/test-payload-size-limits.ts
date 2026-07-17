/**
 * Payload/memo size-limit enforcement lives in sdk-core. These tests only assert that the TS
 * plumbing reaches core: an oversized worker completion is failed proactively (with a forwarded
 * `[TMPRL1103]` error log), the `disablePayloadErrorLimit` opt-out lets the oversized payload reach
 * (and be rejected by) the server, and the connection's `payloadsWarnSize` threshold produces a
 * forwarded `[TMPRL1103]` warning.
 *
 * Requires the ephemeral dev server (downloaded by `TestWorkflowEnvironment.createLocal`).
 */
import test from 'ava';
import { DefaultLogger, NativeConnection, Runtime, makeTelemetryFilterString } from '@temporalio/worker';
import type { LogEntry } from '@temporalio/worker';
import { Client, WorkflowFailedError } from '@temporalio/client';
import proto from '@temporalio/proto'; // eslint-disable-line import/default
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { waitUntil } from '@temporalio/test-helpers';
import { Worker } from './helpers';
import * as activities from './activities';
import { payloadSizeLimitsWorkflow } from './workflows/payload-size-limits';

const { EventType, WorkflowTaskFailedCause } = proto.temporal.api.enums.v1;

const PAYLOAD_ERROR_LIMIT = 10 * 1024;
const PAYLOAD_LIMITS_EXTRA_ARGS = [
  '--dynamic-config-value',
  `limit.blobSize.error=${PAYLOAD_ERROR_LIMIT}`,
  // The server only enforces the error limit for payloads that also exceed the warn limit, so the
  // warn limit must be below the error limit.
  '--dynamic-config-value',
  `limit.blobSize.warn=${2 * 1024}`,
];

// Capture core logs forwarded to the TS logger. Installed once for the file's worker process.
const capturedLogs: LogEntry[] = [];
Runtime.install({
  logger: new DefaultLogger('WARN', (entry) => capturedLogs.push(entry)),
  telemetryOptions: {
    logging: {
      // Default filter; temporalio_common must be admitted (it is) for [TMPRL1103] to be visible.
      filter: makeTelemetryFilterString({ core: 'WARN', other: 'ERROR' }),
      forward: {},
    },
  },
});

function hasLog(level: string, messageSubstring: string): boolean {
  return capturedLogs.some((e) => e.level === level && e.message.includes(messageSubstring));
}

async function withLocalEnv(fn: (env: TestWorkflowEnvironment) => Promise<void>): Promise<void> {
  const env = await TestWorkflowEnvironment.createLocal({
    server: { extraArgs: PAYLOAD_LIMITS_EXTRA_ARGS },
  });
  try {
    await fn(env);
  } finally {
    await env.teardown();
  }
}

test.serial('oversized worker completion is failed by core with a [TMPRL1103] error log', async (t) => {
  capturedLogs.length = 0;
  await withLocalEnv(async (env) => {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: 'payload-size-limits',
      workflowsPath: require.resolve('./workflows'),
      activities,
    });

    // Core repeatedly fails the workflow task (PAYLOADS_TOO_LARGE) for the oversized result, so the
    // workflow never completes and hits its execution timeout.
    const workflowId = `wf-${Date.now()}`;
    await t.throwsAsync(
      worker.runUntil(
        env.client.workflow.execute(payloadSizeLimitsWorkflow, {
          args: [{ activityInputDataSize: 0, workflowOutputDataSize: PAYLOAD_ERROR_LIMIT + 1024 }],
          taskQueue: 'payload-size-limits',
          workflowId,
          workflowExecutionTimeout: '5s',
        })
      ),
      { instanceOf: WorkflowFailedError }
    );

    t.true(hasLog('ERROR', '[TMPRL1103] Attempted to upload payloads with size that exceeded the error limit.'));

    // Failure mechanism: worker reported a WorkflowTaskFailed with PAYLOADS_TOO_LARGE.
    const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
    t.true(
      (events ?? []).some(
        (e) =>
          e.eventType === EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED &&
          e.workflowTaskFailedEventAttributes?.cause ===
            WorkflowTaskFailedCause.WORKFLOW_TASK_FAILED_CAUSE_PAYLOADS_TOO_LARGE
      )
    );
  });
});

test.serial('disablePayloadErrorLimit sends the oversized payload to the server', async (t) => {
  await withLocalEnv(async (env) => {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: 'payload-size-limits-optout',
      workflowsPath: require.resolve('./workflows'),
      activities,
      disablePayloadErrorLimit: true,
    });

    // With the opt-out, core does not pre-fail; the oversized activity input reaches the server,
    // which rejects the ScheduleActivityTask command and fails the workflow.
    await t.throwsAsync(
      worker.runUntil(
        env.client.workflow.execute(payloadSizeLimitsWorkflow, {
          args: [{ activityInputDataSize: PAYLOAD_ERROR_LIMIT + 1024, workflowOutputDataSize: 0 }],
          taskQueue: 'payload-size-limits-optout',
          workflowId: `wf-${Date.now()}`,
          workflowExecutionTimeout: '10s',
        })
      ),
      { instanceOf: WorkflowFailedError }
    );
  });
});

test.serial('connection payloadsWarnSize produces a forwarded [TMPRL1103] warning', async (t) => {
  capturedLogs.length = 0;
  await withLocalEnv(async (env) => {
    // The warn threshold is configured on the (worker's) connection and forwarded to core.
    const connection = await NativeConnection.connect({
      address: env.address,
      payloadLimits: { payloadsWarnSize: 1024 },
    });
    try {
      const worker = await Worker.create({
        connection,
        namespace: env.namespace,
        taskQueue: 'payload-size-limits-warn',
        workflowsPath: require.resolve('./workflows'),
        activities,
      });

      // 2KiB result is above the 1KiB warn threshold but below the 10KiB error limit, so the
      // workflow completes and a warning is logged.
      await worker.runUntil(
        env.client.workflow.execute(payloadSizeLimitsWorkflow, {
          args: [{ activityInputDataSize: 0, workflowOutputDataSize: 2 * 1024 }],
          taskQueue: 'payload-size-limits-warn',
          workflowId: `wf-${Date.now()}`,
          workflowExecutionTimeout: '10s',
        })
      );

      // Core forwards logs on a buffered interval, so the warning may not be visible the instant
      // `runUntil` resolves for this short-lived workflow; wait for it to arrive.
      const warnMessage = '[TMPRL1103] Attempted to upload payloads with size that exceeded the warning limit.';
      await waitUntil(async () => hasLog('WARN', warnMessage), 10_000);
      t.true(hasLog('WARN', warnMessage));
    } finally {
      await connection.close();
    }
  });
});

test.serial('connection memoWarnSize produces a forwarded [TMPRL1103] warning', async (t) => {
  capturedLogs.length = 0;
  await withLocalEnv(async (env) => {
    const connection = await NativeConnection.connect({
      address: env.address,
      payloadLimits: { memoWarnSize: 1024 },
    });
    try {
      const worker = await Worker.create({
        connection,
        namespace: env.namespace,
        taskQueue: 'payload-size-limits-memo-warn',
        workflowsPath: require.resolve('./workflows'),
        activities,
      });

      const client = new Client({ connection, namespace: env.namespace }).workflow;

      // 2KiB memo is above the 1KiB memo warn threshold; input/output stay empty so only the memo warns.
      await worker.runUntil(
        client.execute(payloadSizeLimitsWorkflow, {
          args: [{ activityInputDataSize: 0, workflowOutputDataSize: 0 }],
          taskQueue: 'payload-size-limits-memo-warn',
          workflowId: `wf-${Date.now()}`,
          workflowExecutionTimeout: '10s',
          memo: { key: 'a'.repeat(2048) },
        })
      );

      // Core forwards logs on a buffered interval, so wait for the warning to arrive.
      const warnMessage = '[TMPRL1103] Attempted to upload memo with size that exceeded the warning limit.';
      await waitUntil(async () => hasLog('WARN', warnMessage), 10_000);
      t.true(hasLog('WARN', warnMessage));
    } finally {
      await connection.close();
    }
  });
});
