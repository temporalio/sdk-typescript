import test from 'ava';
import * as nexus from 'nexus-rpc';
import { TemporalOperationHandler } from '../workflow-helpers';

/**
 * Builds a minimal {@link nexus.StartOperationContext} for driving a {@link TemporalOperationHandler}
 * start handler directly. The {@link WorkflowHandle.update} input-validation guards run before any
 * Temporal Client or handler context is touched, so these paths can be exercised without a live
 * worker.
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

test('update without a callback URL fails with a BAD_REQUEST handler error', async (t) => {
  const handler = new TemporalOperationHandler<undefined, number>({
    async start(_ctx, client) {
      // The missing callback URL is what fails the call.
      return await client.getWorkflowHandle('wid').update<number>('someUpdate');
    },
  });

  const err = await t.throwsAsync(() => handler.start(makeStartContext(), undefined));
  t.true(err instanceof nexus.HandlerError);
  t.is((err as nexus.HandlerError).type, 'BAD_REQUEST');
  t.regex(err?.message ?? '', /callback URL is required/);
});
