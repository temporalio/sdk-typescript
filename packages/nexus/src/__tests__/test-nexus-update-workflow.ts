import test from 'ava';
import * as nexus from 'nexus-rpc';
import { WorkflowUpdateStage } from '@temporalio/client';
import { TemporalOperationHandler } from '../workflow-helpers';

/**
 * Builds a minimal {@link nexus.StartOperationContext} for driving a {@link TemporalOperationHandler}
 * start handler directly. The `updateWorkflow` input-validation guards run before any Temporal Client
 * or handler context is touched, so these paths can be exercised without a live worker.
 */
function makeStartContext(overrides: Partial<nexus.StartOperationContext> = {}): nexus.StartOperationContext {
  return {
    service: 'service',
    operation: 'operation',
    headers: {},
    abortSignal: new AbortController().signal,
    requestId: 'request-id',
    inboundLinks: [],
    outboundLinks: [],
    ...overrides,
  };
}

test('updateWorkflow rejects a non-ACCEPTED waitForStage as a failed operation', async (t) => {
  const handler = new TemporalOperationHandler<undefined, number>({
    async start(_ctx, client) {
      return await client.updateWorkflow<number>({
        workflowId: 'wid',
        update: 'someUpdate',
        // Only ACCEPTED is supported for async Nexus Update operations.
        waitForStage: WorkflowUpdateStage.COMPLETED,
      });
    },
  });

  // A callback URL is present so the failure is attributable to the wait stage, not the missing URL.
  const err = await t.throwsAsync(() =>
    handler.start(makeStartContext({ callbackUrl: 'http://callback' }), undefined)
  );
  t.true(err instanceof nexus.OperationError);
  t.is((err as nexus.OperationError).state, 'failed');
  t.regex(err?.message ?? '', /ACCEPTED wait stage/);
});

test('updateWorkflow without a callback URL fails with a BAD_REQUEST handler error', async (t) => {
  const handler = new TemporalOperationHandler<undefined, number>({
    async start(_ctx, client) {
      return await client.updateWorkflow<number>({
        workflowId: 'wid',
        update: 'someUpdate',
        // waitForStage defaults to ACCEPTED, so the missing callback URL is what fails the call.
      });
    },
  });

  const err = await t.throwsAsync(() => handler.start(makeStartContext(), undefined));
  t.true(err instanceof nexus.HandlerError);
  t.is((err as nexus.HandlerError).type, 'BAD_REQUEST');
  t.regex(err?.message ?? '', /callback URL is required/);
});
