import test from 'ava';
import * as nexus from 'nexus-rpc';
import { asyncLocalStorage, type HandlerContext } from '../context';
import { signalWithStartWorkflow } from '../workflow-helpers';
import { makeHandlerContext, makeStartContext } from './helpers';

/**
 * Stands in for the client the worker would put on the handler context, recording the calls the
 * returned handle makes so they can be asserted.
 */
function makeFakeClient(calls: string[]): HandlerContext['client'] {
  return {
    workflow: {
      async signalWithStart(_wf: unknown, _options: unknown) {
        calls.push('signalWithStart');
        return { workflowId: 'wid', signaledRunId: 'rid' };
      },
      getHandle(workflowId: string, runId?: string) {
        return {
          workflowId,
          runId,
          async signal(def: unknown) {
            calls.push(`signal:${String(def)}`);
          },
          async query(def: unknown) {
            calls.push(`query:${String(def)}`);
            return 'query-result';
          },
        };
      },
    },
  } as unknown as HandlerContext['client'];
}

/**
 * Runs `body` against the handle `signalWithStartWorkflow` returns, inside the handler context. The
 * handle's methods read that context themselves, so they have to be called within it, exactly as they
 * would be from inside an operation handler.
 */
async function withSignalWithStartHandle<T>(
  body: (handle: Awaited<ReturnType<typeof signalWithStartWorkflow>>, calls: string[]) => Promise<T>,
  ctxOverrides: Partial<nexus.StartOperationContext> = {}
): Promise<T> {
  const calls: string[] = [];
  const ctx = makeStartContext(ctxOverrides);
  return await asyncLocalStorage.run(makeHandlerContext(makeFakeClient(calls)), async () => {
    const handle = await signalWithStartWorkflow(ctx, 'SomeWorkflow', {
      workflowId: 'wid',
      signal: 'someSignal',
      signalArgs: [],
    } as any);
    return await body(handle, calls);
  });
}

test('the handle returned by signalWithStartWorkflow can signal', async (t) => {
  // The handle used to be a bare object literal cast to WorkflowHandle, so the `signal` its type
  // advertised was undefined at runtime.
  await withSignalWithStartHandle(async (handle, calls) => {
    t.is(handle.workflowId, 'wid');
    t.is(handle.runId, 'rid');

    await handle.signal('anotherSignal');
    t.deepEqual(calls, ['signalWithStart', 'signal:anotherSignal']);
  });
});

test('the handle returned by signalWithStartWorkflow can query', async (t) => {
  await withSignalWithStartHandle(async (handle, calls) => {
    t.is(await handle.query<string>('someQuery'), 'query-result');
    t.deepEqual(calls, ['signalWithStart', 'query:someQuery']);
  });
});

test('the handle returned by signalWithStartWorkflow rejects update with a handler error', async (t) => {
  // The Workflow run this handle refers to already backs the operation, so starting an Update-backed
  // operation from it is a caller error. It must surface as a BAD_REQUEST handler error rather than a
  // TypeError from calling a method the cast only pretended to provide. A callback URL is supplied so
  // the earlier callback-URL guard passes and the reservation is what rejects.
  await withSignalWithStartHandle(
    async (handle) => {
      const err = await t.throwsAsync(() => (handle as any).update('someUpdate'));
      t.true(err instanceof nexus.HandlerError);
      t.is((err as nexus.HandlerError).type, 'BAD_REQUEST');
      t.regex(err?.message ?? '', /already backs it/);
    },
    { callbackUrl: 'http://localhost/callback' }
  );
});
