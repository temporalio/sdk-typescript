import * as nexus from 'nexus-rpc';
import { NexusOperationFailure, TimeoutFailure, TimeoutType } from '@temporalio/common';
import { WorkflowFailedError } from '@temporalio/client';
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

export async function startToCloseTimeoutCallerWorkflow(endpoint: string): Promise<string> {
  const client = workflow.createNexusClient({
    endpoint,
    service: startToCloseService,
  });
  // Use startOperation (not executeOperation) so we can set startToCloseTimeout independently.
  const handle = await client.startOperation(startToCloseService.operations.asyncOp, 'input', {
    startToCloseTimeout: '1s',
  });
  return await handle.result();
}

test('startToCloseTimeout fires when async Nexus operation never completes', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  // The handler immediately returns a fake async token to simulate a long-running operation.
  // It never completes, so startToCloseTimeout fires.
  const asyncOpHandler: nexus.OperationHandler<string, string> = {
    async start(_ctx, _input): Promise<nexus.HandlerStartOperationResult<string>> {
      return nexus.HandlerStartOperationResult.async('fake-operation-token');
    },
    async getInfo(_ctx, _token) {
      throw new nexus.HandlerError('NOT_IMPLEMENTED', 'Not implemented');
    },
    async getResult(_ctx, _token): Promise<string> {
      throw new nexus.HandlerError('NOT_IMPLEMENTED', 'Not implemented');
    },
    async cancel(_ctx, _token) {
      // No-op: nothing to cancel for a fake operation.
    },
  };

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
