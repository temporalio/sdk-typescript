import test from 'ava';
import * as nexus from 'nexus-rpc';
import { TemporalOperationHandler, TemporalOperationResult } from '../workflow-helpers';
import { generateUpdateWorkflowOperationToken } from '../token';

const cancelContext: nexus.CancelOperationContext = {
  abortSignal: new AbortController().signal,
  headers: {},
  operation: 'operation',
  service: 'service',
};

test('cancel of an UpdateWorkflow operation without a custom handler throws NOT_IMPLEMENTED', async (t) => {
  const handler = new TemporalOperationHandler({
    async start() {
      return TemporalOperationResult.sync(undefined);
    },
  });
  const token = generateUpdateWorkflowOperationToken('ns', 'wid', 'rid', 'uid');

  const err = await t.throwsAsync(() => handler.cancel(cancelContext, token));
  t.true(err instanceof nexus.HandlerError);
  t.is((err as nexus.HandlerError).type, 'NOT_IMPLEMENTED');
  t.regex(err?.message ?? '', /cannot cancel an UpdateWorkflow operation/);
});

test('cancel of an UpdateWorkflow operation routes to the custom cancelWorkflowUpdate handler', async (t) => {
  let received: { workflowId: string; runId: string; updateId: string } | undefined;
  const handler = new TemporalOperationHandler({
    async start() {
      return TemporalOperationResult.sync(undefined);
    },
    async cancelWorkflowUpdate(_ctx, options) {
      received = options;
    },
    async cancelWorkflowRun() {
      throw new Error('cancelWorkflowRun should not be called for an UpdateWorkflow token');
    },
  });
  const token = generateUpdateWorkflowOperationToken('ns', 'wid', 'rid', 'uid');

  await handler.cancel(cancelContext, token);
  t.deepEqual(received, { workflowId: 'wid', runId: 'rid', updateId: 'uid' });
});

test('cancel rejects a malformed UpdateWorkflow operation token', async (t) => {
  const handler = new TemporalOperationHandler({
    async start() {
      return TemporalOperationResult.sync(undefined);
    },
    async cancelWorkflowUpdate() {
      throw new Error('cancelWorkflowUpdate should not be called for an invalid token');
    },
  });
  // Type 3 (UpdateWorkflow) but missing the required update ID.
  const token = Buffer.from(JSON.stringify({ t: 3, ns: 'ns', wid: 'wid' })).toString('base64url');

  const err = await t.throwsAsync(() => handler.cancel(cancelContext, token));
  t.true(err instanceof nexus.HandlerError);
  t.is((err as nexus.HandlerError).type, 'BAD_REQUEST');
});
