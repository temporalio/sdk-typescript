import { randomUUID } from 'crypto';
import * as nexus from 'nexus-rpc';
import { NexusOperationFailure, TimeoutFailure, TimeoutType } from '@temporalio/common';
import { WorkflowFailedError } from '@temporalio/client';
import * as temporalnexus from '@temporalio/nexus';
import * as workflow from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({ workflowsPath: __filename });

////////////////////////////////////////////////////////////////////////////////////////////////////
// NEXUS OPERATION SCHEDULE-TO-START TIMEOUT TEST
//
// This test confirms that a NexusOperationFailure with cause TimeoutFailure(SCHEDULE_TO_START) is
// raised when the operation doesn't start within the scheduleToStartTimeout window.
//
// Setup:
//   CallerWorkflow schedules a Nexus operation with scheduleToStartTimeout = 100ms.
//   The worker handling workflow tasks does NOT register any Nexus services, so no worker ever
//   picks up the Nexus task. After 100ms the server fires the SCHEDULE_TO_START timeout.

const scheduleToStartService = nexus.service('nexus-schedule-to-start-timeout-test-service', {
  stallOp: nexus.operation<string, string>(),
});

export async function scheduleToStartTimeoutCallerWorkflow(endpoint: string): Promise<string> {
  const client = workflow.createNexusClient({
    endpoint,
    service: scheduleToStartService,
  });
  return await client.executeOperation(scheduleToStartService.operations.stallOp, 'input', {
    scheduleToStartTimeout: '100ms',
  });
}

test('scheduleToStartTimeout fires when Nexus operation never starts', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  // The worker processes workflow tasks but registers no Nexus services, so the Nexus task is
  // never picked up and the scheduleToStartTimeout fires on the server side.
  const worker = await createWorker();
  const err = await t.throwsAsync(
    worker.runUntil(
      executeWorkflow(scheduleToStartTimeoutCallerWorkflow, {
        args: [endpointName],
      })
    ),
    { instanceOf: WorkflowFailedError }
  );

  if (!(err?.cause instanceof NexusOperationFailure)) {
    return t.fail(`Expected NexusOperationFailure, got: ${err?.cause}`);
  }
  if (!(err.cause.cause instanceof TimeoutFailure)) {
    return t.fail(`Expected TimeoutFailure cause, got: ${err.cause.cause}`);
  }
  t.is(err.cause.cause.timeoutType, TimeoutType.SCHEDULE_TO_START);
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// NEXUS OPERATION START-TO-CLOSE TIMEOUT TEST
//
// This test confirms that a NexusOperationFailure with cause TimeoutFailure(START_TO_CLOSE) is
// raised when an async Nexus operation doesn't complete within the startToCloseTimeout window.
//
// Setup:
//   The Nexus handler immediately returns an async operation token by starting an underlying
//   workflow that blocks forever. The caller uses startOperation with startToCloseTimeout = 100ms,
//   so after the operation starts (token returned) but never completes, START_TO_CLOSE fires.

const startToCloseService = nexus.service('nexus-start-to-close-timeout-test-service', {
  asyncOp: nexus.operation<string, string>(),
});

// Underlying workflow that blocks forever — used as the async operation body.
export async function blockingTargetWorkflow(): Promise<string> {
  await workflow.condition(() => false);
  return ''; // unreachable
}

export async function startToCloseTimeoutCallerWorkflow(endpoint: string): Promise<string> {
  const client = workflow.createNexusClient({
    endpoint,
    service: startToCloseService,
  });
  // Use startOperation (not executeOperation) so we can set startToCloseTimeout independently.
  const handle = await client.startOperation(startToCloseService.operations.asyncOp, 'input', {
    startToCloseTimeout: '100ms',
  });
  return await handle.result();
}

test('startToCloseTimeout fires when async Nexus operation never completes', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  // The handler immediately returns a token by starting an underlying workflow that blocks forever,
  // so the operation starts but never completes within startToCloseTimeout.
  const asyncOpHandler = new temporalnexus.WorkflowRunOperationHandler<string, string>(async (ctx, _input) => {
    return await temporalnexus.startWorkflow(ctx, blockingTargetWorkflow, {
      workflowId: randomUUID(),
      args: [],
    });
  });

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(startToCloseService, {
        asyncOp: asyncOpHandler,
      }),
    ],
  });
  const err = await t.throwsAsync(
    worker.runUntil(
      executeWorkflow(startToCloseTimeoutCallerWorkflow, {
        args: [endpointName],
      })
    ),
    { instanceOf: WorkflowFailedError }
  );

  if (!(err?.cause instanceof NexusOperationFailure)) {
    return t.fail(`Expected NexusOperationFailure, got: ${err?.cause}`);
  }
  if (!(err.cause.cause instanceof TimeoutFailure)) {
    return t.fail(`Expected TimeoutFailure cause, got: ${err.cause.cause}`);
  }
  t.is(err.cause.cause.timeoutType, TimeoutType.START_TO_CLOSE);
});
