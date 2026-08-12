import test from 'ava';
import type * as nexus from 'nexus-rpc';
import { temporal } from '@temporalio/proto';
import { InternalWorkflowQueryOptionsSymbol, type InternalWorkflowHandle } from '@temporalio/client/lib/internal';
import { asyncLocalStorage, type HandlerContext } from '../context';
import { TemporalOperationHandler, TemporalOperationResult } from '../workflow-helpers';
import { makeHandlerContext, makeStartContext } from './helpers';

const WORKFLOW_TYPE = (temporal.api.common.v1.Link.Workflow as any).fullName.slice(1);

function workflowLink(workflowId: string, runId: string, reason: string): temporal.api.common.v1.ILink {
  return { workflow: { namespace: 'ns', workflowId, runId, reason } };
}

/**
 * Stands in for the client the worker would put on the handler context. `query` behaves like the real
 * client handler: it writes the server's response link (when there is one) onto the SDK-internal
 * options payload the caller attached to the handle, then resolves or rejects.
 */
function makeFakeClient(
  responses: Array<{ link?: temporal.api.common.v1.ILink; result?: unknown; reject?: Error }>
): HandlerContext['client'] {
  let next = 0;
  return {
    workflow: {
      getHandle(workflowId: string, runId?: string) {
        const handle = {
          workflowId,
          runId,
          async query(_def: unknown, ..._args: unknown[]): Promise<unknown> {
            const response = responses[next++];
            if (response == null) {
              throw new Error('fake client: more queries than canned responses');
            }
            const internalOptions = (handle as unknown as InternalWorkflowHandle)[InternalWorkflowQueryOptionsSymbol];
            if (internalOptions != null) {
              internalOptions.responseLink = response.link;
            }
            if (response.reject != null) {
              throw response.reject;
            }
            return response.result;
          },
        };
        return handle;
      },
    },
  } as unknown as HandlerContext['client'];
}

/**
 * Runs a start handler that queries the given Workflow, inside a handler context backed by the fake
 * client, and returns the operation context so its `outboundLinks` can be asserted.
 */
async function runQueryOperation(
  client: HandlerContext['client'],
  queries = 1
): Promise<{ ctx: nexus.StartOperationContext; result: unknown; error?: Error }> {
  const ctx = makeStartContext();
  const handler = new TemporalOperationHandler<undefined, unknown>({
    async start(_startCtx, temporalClient) {
      const handle = temporalClient.getWorkflowHandle('wid', 'rid');
      let last: unknown;
      for (let i = 0; i < queries; i++) {
        last = await handle.query<unknown>('getCount');
      }
      return TemporalOperationResult.sync(last);
    },
  });

  try {
    const result = await asyncLocalStorage.run(makeHandlerContext(client), () => handler.start(ctx, undefined));
    return { ctx, result: (result as unknown as { value: unknown }).value };
  } catch (error) {
    return { ctx, result: undefined, error: error as Error };
  }
}

test('a Query response link is attached to the operation outbound links', async (t) => {
  // A Query writes nothing to history, so the server answers with a Workflow link naming the
  // execution that processed it. That link has to reach the operation so the caller's NexusOperation
  // event points back at the queried Workflow.
  const link = workflowLink('wid', 'rid', 'Query processed');
  const { ctx, result, error } = await runQueryOperation(makeFakeClient([{ link, result: 2 }]));

  t.is(error, undefined);
  // Capturing the link must not disturb the Query's own result.
  t.is(result, 2);
  t.is(ctx.outboundLinks.length, 1);
  t.is(ctx.outboundLinks[0]!.type, WORKFLOW_TYPE);
  t.is(ctx.outboundLinks[0]!.url.toString(), 'temporal:///namespaces/ns/workflows/wid/rid?reason=Query+processed');
});

test('an older server that returns no Query link attaches nothing', async (t) => {
  const { ctx, result, error } = await runQueryOperation(makeFakeClient([{ result: 2 }]));

  t.is(error, undefined);
  t.is(result, 2);
  t.deepEqual(ctx.outboundLinks, []);
});

test('two Queries attach both response links in call order', async (t) => {
  const first = workflowLink('callee-a', 'run-a', 'Query processed');
  const second = workflowLink('callee-b', 'run-b', 'Query processed');
  const { ctx, error } = await runQueryOperation(
    makeFakeClient([
      { link: first, result: 1 },
      { link: second, result: 2 },
    ]),
    2
  );

  t.is(error, undefined);
  t.deepEqual(
    ctx.outboundLinks.map((l) => l.url.toString()),
    [
      'temporal:///namespaces/ns/workflows/callee-a/run-a?reason=Query+processed',
      'temporal:///namespaces/ns/workflows/callee-b/run-b?reason=Query+processed',
    ]
  );
});

test('a failed Query still attaches its response link', async (t) => {
  // The server returns a link alongside a rejection or failure, and the client records it before
  // throwing. Pins that the link is attached in a `finally` rather than only on the success path.
  const link = workflowLink('wid', 'rid', 'Query processed');
  const { ctx, error } = await runQueryOperation(makeFakeClient([{ link, reject: new Error('query rejected') }]));

  t.truthy(error);
  t.is(ctx.outboundLinks.length, 1);
  t.is(ctx.outboundLinks[0]!.url.toString(), 'temporal:///namespaces/ns/workflows/wid/rid?reason=Query+processed');
});

test('an unconvertible response link is dropped rather than failing the operation', async (t) => {
  // A link variant the converter does not handle is logged and skipped; links are not essential to
  // the operation succeeding.
  const { ctx, result, error } = await runQueryOperation(
    makeFakeClient([{ link: { batchJob: { jobId: 'batch' } }, result: 2 }])
  );

  t.is(error, undefined);
  t.is(result, 2);
  t.deepEqual(ctx.outboundLinks, []);
});
