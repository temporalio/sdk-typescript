import * as nexus from 'nexus-rpc';
import { CancelledFailure, NexusOperationFailure, TimeoutFailure, TimeoutType } from '@temporalio/common';
import { WorkflowFailedError } from '@temporalio/client';
import * as workflow from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';
import { waitUntil } from './helpers';

const test = makeTestFunction({ workflowsPath: __filename });

const syncOpService = nexus.service('testService', {
  testSyncOp: nexus.operation<string, string>(),
});

const blockingOpService = nexus.service('testService', {
  blockingOp: nexus.operation<void, void>(),
});

// Caller workflow — invokes sync Nexus op and returns result
export async function syncOpCaller(endpoint: string): Promise<string> {
  const client = workflow.createNexusClient({ endpoint, service: syncOpService });
  return await client.executeOperation('testSyncOp', 'hello');
}

// Caller workflow — invokes blocking op (for cancellation test).
// Uses TRY_CANCEL so the workflow doesn't hang waiting for the sync op's
// cancellation to complete (sync ops have no Nexus cancel handler).
export async function cancelSyncOpCaller(endpoint: string): Promise<void> {
  const client = workflow.createNexusClient({ endpoint, service: blockingOpService });
  return await client.executeOperation('blockingOp', undefined, {
    cancellationType: 'TRY_CANCEL',
  });
}

test('sync Operation Handler happy path - caller workflow', async (t) => {
  const { createWorker, executeWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(syncOpService, {
        async testSyncOp(_ctx, input) {
          return input; // echo
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(syncOpCaller, {
      args: [endpointName],
    });
    t.is(result, 'hello');
  });
});

test('Operation Handler cancellation via workflow cancel', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  let abortPromise: Promise<never> | undefined;

  const worker = await createWorker({
    nexusServices: [
      nexus.serviceHandler(blockingOpService, {
        async blockingOp(ctx) {
          abortPromise = new Promise<never>((_, reject) => {
            ctx.abortSignal.onabort = () => reject(ctx.abortSignal.reason);
          });
          return await abortPromise;
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const callerHandle = await startWorkflow(cancelSyncOpCaller, {
      args: [endpointName],
    });

    // Wait for the Nexus Operation to be scheduled (sync ops that block forever
    // never emit a NexusOperationStartedEvent, so we wait for scheduled instead).
    await waitUntil(
      async () =>
        !!(await callerHandle.fetchHistory()).events?.some((ev) => ev.nexusOperationScheduledEventAttributes),
      4000
    );
    // Give the worker time to pick up and start executing the blocking handler.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // ...and then cancel the caller workflow
    await callerHandle.cancel();

    const err = await t.throwsAsync(callerHandle.result(), {
      instanceOf: WorkflowFailedError,
    });

    if (!(err?.cause instanceof CancelledFailure)) {
      return t.fail(`Expected CancelledFailure, got: ${err?.cause}`);
    }

    // Verify the abort signal actually fired and rejected the handler's promise.
    t.truthy(abortPromise);
    await t.throwsAsync(abortPromise!, { instanceOf: CancelledFailure });
  });
});
