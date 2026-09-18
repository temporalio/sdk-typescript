import test from 'ava';
import * as nexus from 'nexus-rpc';
import { TemporalOperationHandler } from '../workflow-helpers';
import { makeStartContext } from './helpers';

test('update without a callback URL fails with a BAD_REQUEST handler error', async (t) => {
  const handler = new TemporalOperationHandler<undefined, number>({
    async start(_ctx, client) {
      // The missing callback URL is what fails the call.
      return await client.getWorkflowHandle('wid').update<number>('someUpdate', { waitForStage: 'ACCEPTED' });
    },
  });

  const err = await t.throwsAsync(() => handler.start(makeStartContext(), undefined));
  t.true(err instanceof nexus.HandlerError);
  t.is((err as nexus.HandlerError).type, 'BAD_REQUEST');
  t.regex(err?.message ?? '', /callback URL is required/);
});

test('update with a stage other than ACCEPTED fails with a TypeError', async (t) => {
  const handler = new TemporalOperationHandler<undefined, number>({
    async start(_ctx, client) {
      // `waitForStage` only accepts ACCEPTED at the type level; cast to reach the runtime guard the
      // way an untyped JavaScript caller would.
      return await client.getWorkflowHandle('wid').update<number>('someUpdate', {
        waitForStage: 'COMPLETED',
      } as any);
    },
  });

  const ctx = makeStartContext({ callbackUrl: 'http://localhost/callback' });
  const err = await t.throwsAsync(() => handler.start(ctx, undefined));
  t.true(err instanceof TypeError);
  t.regex(err?.message ?? '', /Only waitForStage 'ACCEPTED' is supported/);
});
