import test from 'ava';
import * as nexus from 'nexus-rpc';
import { InternalWorkflowSignalOptionsSymbol, InternalWorkflowStartOptionsSymbol } from '@temporalio/client/internal';
import { asyncLocalStorage, type HandlerContext } from '../context';
import {
  signalWithStartWorkflow,
  startWorkflow,
  TemporalOperationHandler,
  TemporalOperationResult,
  type TemporalNexusClient,
} from '../workflow-helpers';
import { makeHandlerContext, makeStartContext } from './helpers';

const REQUEST_ID = 'nexus-op-request-id';

/**
 * Stands in for the client the worker would put on the handler context, recording the request ID
 * each signal RPC would carry (`undefined` meaning the client generates its own). Calls listed in
 * `failures` throw once, in order.
 */
function makeFakeClient(requestIds: (string | undefined)[], failures: string[] = []): HandlerContext['client'] {
  const maybeFail = (call: string) => {
    if (failures[0] === call) {
      failures.shift();
      throw new Error(`${call} unavailable`);
    }
  };
  return {
    workflow: {
      async signalWithStart(_wf: unknown, options: any) {
        maybeFail('signalWithStart');
        requestIds.push(options[InternalWorkflowStartOptionsSymbol]?.requestId);
        return { workflowId: options.workflowId, signaledRunId: 'rid' };
      },
      async start(_wf: unknown, options: any) {
        return { workflowId: options.workflowId, firstExecutionRunId: 'rid' };
      },
      getHandle(workflowId: string, runId?: string) {
        return {
          workflowId,
          runId,
          async signal(this: any) {
            maybeFail('signal');
            requestIds.push(this[InternalWorkflowSignalOptionsSymbol]?.requestId);
          },
        };
      },
    },
  } as unknown as HandlerContext['client'];
}

type Send = (client: TemporalNexusClient) => Promise<unknown>;

const sendSignal =
  (workflowId: string): Send =>
  (client) =>
    client.getWorkflowHandle(workflowId).signal('test-signal', 'payload');

const sendSignalWithStart =
  (workflowId: string): Send =>
  (client) =>
    client.signalWithStartWorkflow('TestWorkflow', {
      workflowId,
      signal: 'test-signal',
      signalArgs: ['signal-payload'],
    } as any);

/**
 * Runs `body` as the start handler of a {@link TemporalOperationHandler} invocation, the way the
 * worker would, and returns the request IDs the signal RPCs carried.
 */
async function runInOperation(
  body: (client: TemporalNexusClient) => Promise<void>,
  failures: string[] = []
): Promise<(string | undefined)[]> {
  const requestIds: (string | undefined)[] = [];
  const handler = new TemporalOperationHandler<void, void>({
    async start(_ctx, client) {
      await body(client);
      return TemporalOperationResult.sync(undefined);
    },
  });
  await asyncLocalStorage.run(makeHandlerContext(makeFakeClient(requestIds, failures)), () =>
    handler.start(makeStartContext({ requestId: REQUEST_ID }), undefined)
  );
  return requestIds;
}

for (const [name, send] of [
  ['signal', sendSignal('wf-target')],
  ['signalWithStart', sendSignalWithStart('wf-target')],
] as const) {
  test(`${name} from a Temporal operation handler uses the operation's request ID`, async (t) => {
    t.deepEqual(
      await runInOperation(async (client) => {
        await send(client);
      }),
      [REQUEST_ID]
    );
  });
}

for (const [name, createHandle, expected] of [
  [
    'signalWithStartWorkflow',
    (ctx: nexus.StartOperationContext) =>
      signalWithStartWorkflow(ctx, 'TestWorkflow', {
        workflowId: 'wf-target',
        signal: 'test-signal',
        signalArgs: [],
      } as any),
    // The signal-with-start itself, then the handle's signal.
    [undefined, undefined],
  ],
  [
    'startWorkflow',
    (ctx: nexus.StartOperationContext) => startWorkflow(ctx, 'TestWorkflow', { workflowId: 'wf-target' } as any),
    // Only the handle's signal; the start RPC isn't recorded.
    [undefined],
  ],
] as const) {
  test(`signals from the standalone ${name} do not pass a request ID to the client`, async (t) => {
    // Only the Temporal operation handler's client supplies the operation's request ID. Without one,
    // the client generates its own.
    const requestIds: (string | undefined)[] = [];
    await asyncLocalStorage.run(makeHandlerContext(makeFakeClient(requestIds)), async () => {
      const handle = await createHandle(makeStartContext({ requestId: REQUEST_ID }));
      await handle.signal('test-signal');
    });
    t.deepEqual(requestIds, expected);
  });
}

for (const [name, first, second] of [
  ['same workflow', sendSignal('wf-target'), sendSignal('wf-target')],
  ['different workflow', sendSignal('wf-target'), sendSignal('other-wf')],
  ['signal then signalWithStart', sendSignal('wf-target'), sendSignalWithStart('wf-target')],
  ['signalWithStart then signal', sendSignalWithStart('wf-target'), sendSignal('wf-target')],
  ['signalWithStart twice', sendSignalWithStart('wf-target'), sendSignalWithStart('other-wf')],
] as const) {
  test(`only one signal per invocation: ${name}`, async (t) => {
    const requestIds = await runInOperation(async (client) => {
      await first(client);
      const err = await t.throwsAsync(() => second(client));
      t.true(err instanceof nexus.HandlerError);
      t.is((err as nexus.HandlerError).type, 'BAD_REQUEST');
      t.regex(err!.message, /Only one signal can be sent per operation handler invocation/);
    });
    t.deepEqual(requestIds, [REQUEST_ID]);
  });
}

test('concurrent signals are limited to one', async (t) => {
  const requestIds = await runInOperation(async (client) => {
    const results = await Promise.allSettled([sendSignal('wf-target')(client), sendSignal('other-wf')(client)]);
    t.deepEqual(
      results.map((r) => r.status),
      ['fulfilled', 'rejected']
    );
  });
  t.deepEqual(requestIds, [REQUEST_ID]);
});

for (const [name, send] of [
  ['signal', sendSignal('wf-target')],
  ['signalWithStart', sendSignalWithStart('wf-target')],
] as const) {
  test(`a failed ${name} does not consume the invocation's signal`, async (t) => {
    // Retrying within the invocation is safe because the retry reuses the request ID.
    const requestIds = await runInOperation(
      async (client) => {
        await t.throwsAsync(() => send(client), { message: `${name} unavailable` });
        await send(client);
      },
      [name]
    );
    t.deepEqual(requestIds, [REQUEST_ID]);
  });
}
