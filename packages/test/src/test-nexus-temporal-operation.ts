import assert from 'assert';
import test from 'ava';
import * as nexus from 'nexus-rpc';
import type { Client } from '@temporalio/client';
import { type InternalActivityStartOptions, InternalActivityStartOptionsSymbol } from '@temporalio/client/lib/internal';
import * as temporalnexus from '@temporalio/nexus';
import { asyncLocalStorage } from '@temporalio/nexus/lib/context';
import { base64URLEncodeNoPadding, OperationTokenType } from '@temporalio/nexus/lib/token';

async function echoWorkflow(input: string): Promise<string> {
  return input;
}

const activities = {
  async echo(message?: string): Promise<string> {
    return message ?? '';
  },
};

test('TemporalOperationHandler infers correct output type from typed workflow function', async (t) => {
  const _stringOp: nexus.OperationHandler<string, string> = new temporalnexus.TemporalOperationHandler({
    async start(_ctx, client, input: string) {
      return await client.startWorkflow(echoWorkflow, {
        args: [input],
        workflowId: 'test',
      });
    },
  });

  // @ts-expect-error - Output type should be string, not number
  const _mismatchedOp: nexus.OperationHandler<string, number> = new temporalnexus.TemporalOperationHandler({
    async start(_ctx, client, input: string) {
      return await client.startWorkflow(echoWorkflow, {
        args: [input],
        workflowId: 'test',
      });
    },
  });

  const _syncOp: nexus.OperationHandler<string, string> = new temporalnexus.TemporalOperationHandler({
    async start(_ctx, _client, input: string) {
      return temporalnexus.TemporalOperationResult.sync(input);
    },
  });

  const _explicitStringOp: nexus.OperationHandler<string, string> = new temporalnexus.TemporalOperationHandler<
    string,
    string
  >({
    async start(_ctx, client, input) {
      return await client.startWorkflow(echoWorkflow, {
        args: [input],
        workflowId: 'test',
      });
    },
  });

  // This test only checks for compile-time errors.
  t.pass();
});

test('TemporalOperationHandler infers correct output type from typed activity', async (t) => {
  // echo(message?: string): Promise<string>, so typedActivity().startActivity('echo', ...)
  // resolves to TemporalOperationResult<string> and the operation output type infers as string.
  const _activityStringOp: nexus.OperationHandler<string, string> = new temporalnexus.TemporalOperationHandler({
    async start(_ctx, client, input: string) {
      return await client.typedActivity<typeof activities>().startActivity('echo', {
        id: 'test',
        args: [input],
        scheduleToCloseTimeout: '10s',
      });
    },
  });

  // @ts-expect-error - Output type should be string (echo returns string), not number
  const _activityMismatchedOp: nexus.OperationHandler<string, number> = new temporalnexus.TemporalOperationHandler({
    async start(_ctx, client, input: string) {
      return await client.typedActivity<typeof activities>().startActivity('echo', {
        id: 'test',
        args: [input],
        scheduleToCloseTimeout: '10s',
      });
    },
  });

  const _activityWrongArgsOp: nexus.OperationHandler<string, string> = new temporalnexus.TemporalOperationHandler({
    async start(_ctx, client, _input: string) {
      return await client.typedActivity<typeof activities>().startActivity('echo', {
        id: 'test',
        // @ts-expect-error - echo expects a string argument, not a number
        args: [42],
        scheduleToCloseTimeout: '10s',
      });
    },
  });

  const _activityUnknownNameOp = new temporalnexus.TemporalOperationHandler({
    async start(_ctx, client, input: string) {
      // @ts-expect-error - The activity name must be a key of the provided activity interface
      return await client.typedActivity<typeof activities>().startActivity('missingActivity', {
        id: 'test',
        args: [input],
        scheduleToCloseTimeout: '10s',
      });
    },
  });

  const _explicitActivityStringOp: nexus.OperationHandler<string, string> = new temporalnexus.TemporalOperationHandler<
    string,
    string
  >({
    async start(_ctx, client, input) {
      return await client.typedActivity<typeof activities>().startActivity('echo', {
        id: 'test',
        args: [input],
        scheduleToCloseTimeout: '10s',
      });
    },
  });

  // This test only checks for compile-time errors.
  t.pass();
});

test('TemporalOperationHandler respects explicit output type from untyped activity', async (t) => {
  const _untypedActivityStringOp: nexus.OperationHandler<string, string> = new temporalnexus.TemporalOperationHandler({
    async start(_ctx, client, input: string) {
      return await client.startActivity<string>('echo', {
        id: 'test',
        args: [input],
        scheduleToCloseTimeout: '10s',
      });
    },
  });

  // @ts-expect-error - Explicit activity result type is string, not number
  const _untypedActivityMismatchedOp: nexus.OperationHandler<string, number> =
    new temporalnexus.TemporalOperationHandler({
      async start(_ctx, client, input: string) {
        return await client.startActivity<string>('echo', {
          id: 'test',
          args: [input],
          scheduleToCloseTimeout: '10s',
        });
      },
    });

  // This test only checks for compile-time errors.
  t.pass();
});

test('TemporalOperationHandler.cancel rejects invalid operation token type before invoking cancellation hooks', async (t) => {
  const handler = new temporalnexus.TemporalOperationHandler({
    async start(_ctx, _client, _input) {
      return temporalnexus.TemporalOperationResult.sync(undefined);
    },

    async cancelWorkflowRun(_ctx, _options) {
      throw new Error('cancelWorkflowRun should not be called');
    },
  });
  const token = base64URLEncodeNoPadding(JSON.stringify({ t: 99, ns: 'test-namespace' }));

  const err = await asyncLocalStorage.run(
    {
      client: undefined as any,
      endpoint: 'test-endpoint',
      namespace: 'test-namespace',
      taskQueue: 'test-task-queue',
      log: undefined as any,
      metrics: undefined as any,
    },
    async () => {
      return await t.throwsAsync(
        handler.cancel(
          {
            abortSignal: new AbortController().signal,
            headers: {},
            operation: 'operation',
            service: 'service',
          },
          token
        )
      );
    }
  );

  t.regex(err?.message ?? '', /invalid operation token/);
});

test('TemporalOperationHandler.cancel rejects malformed activity token before invoking cancelActivity', async (t) => {
  let cancelActivityCalled = false;
  const handler = new temporalnexus.TemporalOperationHandler({
    async start(_ctx, _client, _input) {
      return temporalnexus.TemporalOperationResult.sync(undefined);
    },

    async cancelActivity(_ctx, _options) {
      cancelActivityCalled = true;
      throw new Error('cancelActivity should not be called');
    },
  });
  const token = base64URLEncodeNoPadding(JSON.stringify({ t: OperationTokenType.ACTIVITY, ns: 'test-namespace' }));

  const err = await asyncLocalStorage.run(
    {
      client: undefined as any,
      endpoint: 'test-endpoint',
      namespace: 'test-namespace',
      taskQueue: 'test-task-queue',
      log: undefined as any,
      metrics: undefined as any,
    },
    async () => {
      return await t.throwsAsync(
        handler.cancel(
          {
            abortSignal: new AbortController().signal,
            headers: {},
            operation: 'operation',
            service: 'service',
          },
          token
        )
      );
    }
  );

  assert(err instanceof nexus.HandlerError);
  t.is(err.type, 'BAD_REQUEST');
  t.regex(err.message, /invalid activity operation token/);
  t.false(cancelActivityCalled, 'cancelActivity must not be invoked for a malformed activity token');
});

test('TemporalOperationHandler places activity links based on callback presence', async (t) => {
  const inboundLink: nexus.Link = {
    type: 'temporal.api.common.v1.Link.NexusOperation',
    url: new URL('temporal:///namespaces/ns/nexus-operations/operation-id/run-id/details'),
  };
  const expectedLinks = [
    {
      nexusOperation: {
        namespace: 'ns',
        operationId: 'operation-id',
        runId: 'run-id',
      },
    },
  ];
  const makeStartContext = (callbackUrl?: string): nexus.StartOperationContext => ({
    service: 'service',
    operation: 'operation',
    headers: {},
    abortSignal: new AbortController().signal,
    requestId: 'request-id',
    callbackUrl,
    callbackHeaders: { callback: 'header' },
    inboundLinks: [inboundLink],
    outboundLinks: [],
  });
  const captureStartOptions = async (
    callbackUrl?: string
  ): Promise<NonNullable<InternalActivityStartOptions[typeof InternalActivityStartOptionsSymbol]>> => {
    let capturedOptions: InternalActivityStartOptions | undefined;
    const client = {
      activity: {
        async start(_activity: string, options: InternalActivityStartOptions) {
          capturedOptions = options;
          return { activityId: options.id, runId: 'activity-run-id' };
        },
      },
    } as unknown as Client;
    const handler = new temporalnexus.TemporalOperationHandler<undefined, unknown>({
      async start(_ctx, nexusClient) {
        return await nexusClient.startActivity('activity', {
          id: 'activity-id',
          scheduleToCloseTimeout: '1m',
        });
      },
    });

    await asyncLocalStorage.run(
      {
        client,
        endpoint: 'endpoint',
        namespace: 'ns',
        taskQueue: 'task-queue',
        log: undefined as any,
        metrics: undefined as any,
      },
      () => handler.start(makeStartContext(callbackUrl), undefined)
    );

    const internalOptions = capturedOptions?.[InternalActivityStartOptionsSymbol];
    if (internalOptions == null) {
      throw new Error('Activity start did not receive internal Nexus options');
    }
    return internalOptions;
  };

  const withCallback = await captureStartOptions('https://callback.example');
  t.is(withCallback.links, undefined);
  t.deepEqual(withCallback.completionCallbacks?.[0]?.links, expectedLinks);

  const withoutCallback = await captureStartOptions();
  t.deepEqual(withoutCallback.links, expectedLinks);
  t.is(withoutCallback.completionCallbacks, undefined);
});
