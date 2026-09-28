import test from 'ava';
import * as nexus from 'nexus-rpc';
import { TemporalOperationHandler } from '../workflow-helpers';
import { makeStartContext } from './helpers';

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
