import { randomUUID } from 'crypto';
import * as nexus from 'nexus-rpc';
import {
  Client,
  createCompletionCallback,
  NexusOperationFailureError,
  type NexusClientInterceptor,
  type StartNexusOperationInput,
} from '@temporalio/client';
import {
  ApplicationFailure,
  CancelledFailure,
  defaultPayloadConverter,
  type PayloadCodec,
  RawValue,
  rawValueTypeInfo,
  TerminatedFailure,
  type TypeInfo,
} from '@temporalio/common';
import { decode, encode } from '@temporalio/common/lib/encoding';
import * as temporalnexus from '@temporalio/nexus';
import { temporal } from '@temporalio/proto';
import * as workflow from '@temporalio/workflow';
// Not @temporalio/nexus/notifications: the test bundler ignores @temporalio/nexus in workflow code
import {
  createOnCompleteRequestTransferTypeConverter,
  onCompleteResponseTransferTypeConverter,
  type OnCompleteRequest,
  type OnCompleteResponse,
} from '@temporalio/common/nexus';
import { helpers, makeTestFunction } from './helpers-integration';
import { waitUntil } from './helpers';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowEnvironmentOpts: {
    server: {
      executable: { type: 'cached-download', version: 'v1.9.3-nexus-serialization-context' },
      extraArgs: [
        '--dynamic-config-value',
        'nexusoperation.enableStandalone=true',
        '--dynamic-config-value',
        'system.refreshNexusEndpointsMinWait="0s"',
        '--dynamic-config-value',
        'history.enableChasmCallbacks=true',
      ],
    },
  },
});

const testService = nexus.service('callbackTestService', {
  echo: nexus.operation<string, { value: string }>(),
  fail: nexus.operation<string, { value: string }>(),
  blocking: nexus.operation<string, { value: string }>(),
});

interface CallbackContext {
  label: string;
}

const notificationService = nexus.service('callback.test.NotificationService', {
  onComplete: nexus.operation<OnCompleteRequest<{ value: string }, CallbackContext>, OnCompleteResponse>({
    name: 'OnComplete',
    inputType: { transferTypeConverter: createOnCompleteRequestTransferTypeConverter() },
    outputType: { transferTypeConverter: onCompleteResponseTransferTypeConverter },
  }),
});

const rawNotificationService = nexus.service('callback.test.RawNotificationService', {
  onComplete: nexus.operation<OnCompleteRequest<RawValue, CallbackContext>, OnCompleteResponse>({
    inputType: {
      transferTypeConverter: createOnCompleteRequestTransferTypeConverter<RawValue, CallbackContext>({
        outputT: rawValueTypeInfo,
      }),
    },
    outputType: { transferTypeConverter: onCompleteResponseTransferTypeConverter },
  }),
});

/** Reversible codec that rejects payloads it did not encode. */
const prefixCodec: PayloadCodec = {
  async encode(payloads) {
    return payloads.map((payload) => ({
      metadata: { encoding: encode('test/prefix') },
      data: temporal.api.common.v1.Payload.encode(payload).finish(),
    }));
  },
  async decode(payloads) {
    return payloads.map((payload) => {
      const encoding = payload.metadata?.encoding;
      if (encoding == null || decode(encoding) !== 'test/prefix') {
        throw new Error(`unexpected payload passed to codec: ${encoding && decode(encoding)}`);
      }
      return temporal.api.common.v1.Payload.decode(payload.data!);
    });
  },
};

export async function echoWorkflow(input: string): Promise<{ value: string }> {
  return { value: input };
}

export async function failWorkflow(input: string): Promise<{ value: string }> {
  throw ApplicationFailure.create({ message: input, details: ['detail'], nonRetryable: true });
}

export async function blockForever(): Promise<{ value: string }> {
  await workflow.condition(() => false);
  throw new Error('unreachable');
}

export async function recordCompletion(output: { value: string }): Promise<OnCompleteResponse> {
  if (output.value !== 'hello') throw new Error(`unexpected output: ${output.value}`);
  return {};
}

function startsWorkflow<O>(workflowFn: (input: string) => Promise<O>) {
  return new temporalnexus.WorkflowRunOperationHandler<string, O>((ctx, input) =>
    temporalnexus.startWorkflow(ctx, workflowFn, { workflowId: randomUUID(), args: [input] })
  );
}

function makeHandlers() {
  // Keyed by label so redelivered callbacks don't count twice
  const requests = new Map<string, OnCompleteRequest<unknown, CallbackContext>>();
  return {
    requests,
    handlers: [
      nexus.serviceHandler(testService, {
        echo: startsWorkflow(echoWorkflow),
        fail: startsWorkflow(failWorkflow),
        blocking: new temporalnexus.WorkflowRunOperationHandler<string, { value: string }>(async (ctx, workflowId) => {
          return await temporalnexus.startWorkflow(ctx, blockForever, { workflowId });
        }),
      }),
      nexus.serviceHandler(notificationService, {
        async onComplete(_ctx, input) {
          requests.set(input.sourceContext.label, input);
          return {};
        },
      }),
    ],
  };
}

function makeRawHandler() {
  const requests = new Map<string, OnCompleteRequest<RawValue, CallbackContext>>();
  const handler = nexus.serviceHandler(rawNotificationService, {
    async onComplete(_ctx, input) {
      requests.set(input.sourceContext.label, input);
      return {};
    },
  });
  return { requests, handler };
}

test('completion callback delivers success', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { requests, handlers } = makeHandlers();
  const worker = await createWorker({ nexusServices: handlers });

  await worker.runUntil(async () => {
    const svc = t.context.env.client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const result = await svc.executeOperation(testService.operations.echo, 'hello', {
      id: 'op-' + randomUUID(),
      scheduleToCloseTimeout: '10s',
      completionCallbacks: [
        createCompletionCallback({
          service: notificationService,
          operation: notificationService.operations.onComplete,
          taskQueue: worker.options.taskQueue,
          sourceContext: { label: 'success' },
        }),
      ],
    });
    t.deepEqual(result, { value: 'hello' });

    await waitUntil(async () => requests.has('success'), 10_000);
    t.deepEqual([...requests.keys()], ['success']);
    t.deepEqual(requests.get('success'), {
      result: { tag: 'success', value: { value: 'hello' } },
      sourceContext: { label: 'success' },
    });
  });
});

test('completion callback delivers failure', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { requests, handlers } = makeHandlers();
  const worker = await createWorker({ nexusServices: handlers });

  await worker.runUntil(async () => {
    const svc = t.context.env.client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    await t.throwsAsync(
      svc.executeOperation(testService.operations.fail, 'callback test failure', {
        id: 'op-' + randomUUID(),
        scheduleToCloseTimeout: '10s',
        completionCallbacks: [
          createCompletionCallback({
            service: notificationService,
            operation: notificationService.operations.onComplete,
            taskQueue: worker.options.taskQueue,
            sourceContext: { label: 'failure' },
          }),
        ],
      }),
      { instanceOf: NexusOperationFailureError }
    );

    await waitUntil(async () => requests.has('failure'), 10_000);
    const request = requests.get('failure')!;
    t.deepEqual(request.sourceContext, { label: 'failure' });
    t.is(request.result.tag, 'failure');
    const failure = request.result.value;
    t.true(failure instanceof ApplicationFailure);
    t.is((failure as ApplicationFailure).message, 'callback test failure');
    t.deepEqual((failure as ApplicationFailure).details, ['detail']);
  });
});

for (const outcome of ['cancel', 'terminate'] as const) {
  test(`completion callback delivers ${outcome}`, async (t) => {
    const { createWorker, registerNexusEndpoint } = helpers(t);
    const { endpointName } = await registerNexusEndpoint();
    const { requests, handlers } = makeHandlers();
    const worker = await createWorker({ nexusServices: handlers });
    const workflowId = `${outcome}-${randomUUID()}`;

    await worker.runUntil(async () => {
      const client = t.context.env.client;
      const svc = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
      const handle = await svc.startOperation(testService.operations.blocking, workflowId, {
        id: 'op-' + randomUUID(),
        scheduleToCloseTimeout: '30s',
        completionCallbacks: [
          createCompletionCallback({
            service: notificationService,
            operation: notificationService.operations.onComplete,
            taskQueue: worker.options.taskQueue,
            sourceContext: { label: outcome },
          }),
        ],
      });
      // Wait for the handler workflow so the operation is running when it is stopped
      await waitUntil(
        () =>
          client.workflow
            .getHandle(workflowId)
            .describe()
            .then(
              () => true,
              () => false
            ),
        10_000
      );

      if (outcome === 'cancel') {
        await handle.cancel('callback test cancel');
      } else {
        await handle.terminate('callback test termination');
        // Terminating the operation leaves its handler workflow running
        await client.workflow.getHandle(workflowId).terminate();
      }
      await t.throwsAsync(handle.result(), { instanceOf: NexusOperationFailureError });

      await waitUntil(async () => requests.has(outcome), 10_000);
      const request = requests.get(outcome)!;
      t.deepEqual(request.sourceContext, { label: outcome });
      t.is(request.result.tag, 'failure');
      if (outcome === 'cancel') {
        t.true(request.result.value instanceof CancelledFailure);
      } else {
        t.true(request.result.value instanceof TerminatedFailure);
        t.is((request.result.value as Error).message, 'callback test termination');
      }
    });
  });
}

test('multiple completion callbacks are passed to interceptors and delivered', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { requests, handlers } = makeHandlers();
  const worker = await createWorker({ nexusServices: handlers });
  const startInputs: StartNexusOperationInput[] = [];
  const interceptor: NexusClientInterceptor = {
    async startOperation(input, next) {
      startInputs.push(input);
      return await next(input);
    },
  };
  const client = new Client({
    connection: t.context.env.connection,
    namespace: t.context.env.namespace,
    interceptors: { nexus: [interceptor] },
  });

  await worker.runUntil(async () => {
    const completionCallbacks = ['first', 'second'].map((label) =>
      createCompletionCallback({
        service: notificationService,
        operation: notificationService.operations.onComplete,
        taskQueue: worker.options.taskQueue,
        sourceContext: { label },
      })
    );
    const svc = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const result = await svc.executeOperation('echo', 'hello', {
      id: 'op-' + randomUUID(),
      scheduleToCloseTimeout: '10s',
      completionCallbacks,
    });
    t.deepEqual(result, { value: 'hello' });
    t.deepEqual(
      startInputs.map((input) => input.completionCallbacks),
      [completionCallbacks]
    );

    await waitUntil(async () => requests.size === 2, 10_000);
    for (const label of ['first', 'second']) {
      t.deepEqual(requests.get(label), {
        result: { tag: 'success', value: { value: 'hello' } },
        sourceContext: { label },
      });
    }
  });
});

test('on-complete operation can start an activity', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const label = randomUUID();
  const outputs = new Map<string, { value: string }>();
  const activities = {
    async recordCompletionActivity(label: string, output: { value: string }): Promise<OnCompleteResponse> {
      outputs.set(label, output);
      return {};
    },
  };
  const activityNotificationService = nexus.service('callback.test.ActivityNotificationService', {
    onComplete: nexus.operation<OnCompleteRequest<{ value: string }, CallbackContext>, OnCompleteResponse>({
      inputType: { transferTypeConverter: createOnCompleteRequestTransferTypeConverter() },
      outputType: { transferTypeConverter: onCompleteResponseTransferTypeConverter },
    }),
  });
  const activityHandler = nexus.serviceHandler(activityNotificationService, {
    onComplete: new temporalnexus.TemporalOperationHandler<
      OnCompleteRequest<{ value: string }, CallbackContext>,
      OnCompleteResponse
    >({
      async start(_ctx, client, input) {
        if (input.result.tag !== 'success') throw new Error('expected a successful result');
        return await client.typedActivity<typeof activities>().startActivity('recordCompletionActivity', {
          id: `on-complete-${input.sourceContext.label}`,
          args: [input.sourceContext.label, input.result.value],
          scheduleToCloseTimeout: '10s',
        });
      },
    }),
  });
  const worker = await createWorker({ activities, nexusServices: [...makeHandlers().handlers, activityHandler] });

  await worker.runUntil(async () => {
    const client = t.context.env.client;
    const svc = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const result = await svc.executeOperation('echo', 'hello', {
      id: 'op-' + randomUUID(),
      scheduleToCloseTimeout: '10s',
      completionCallbacks: [
        createCompletionCallback({
          service: activityNotificationService,
          operation: activityNotificationService.operations.onComplete,
          taskQueue: worker.options.taskQueue,
          sourceContext: { label },
        }),
      ],
    });
    t.deepEqual(result, { value: 'hello' });

    await waitUntil(async () => outputs.has(label), 10_000);
    t.deepEqual(outputs.get(label), { value: 'hello' });
    t.deepEqual(await client.activity.getHandle(`on-complete-${label}`).result(), {});
  });
});

test('on-complete operation can start a workflow linked to the callback', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const label = randomUUID();
  const workflowNotificationService = nexus.service('callback.test.WorkflowNotificationService', {
    onComplete: nexus.operation<OnCompleteRequest<{ value: string }, CallbackContext>, OnCompleteResponse>({
      inputType: { transferTypeConverter: createOnCompleteRequestTransferTypeConverter() },
      outputType: { transferTypeConverter: onCompleteResponseTransferTypeConverter },
    }),
  });
  const workflowHandler = nexus.serviceHandler(workflowNotificationService, {
    onComplete: new temporalnexus.TemporalOperationHandler<
      OnCompleteRequest<{ value: string }, CallbackContext>,
      OnCompleteResponse
    >({
      async start(_ctx, client, input) {
        if (input.result.tag !== 'success') throw new Error('expected a successful result');
        return await client.startWorkflow(recordCompletion, {
          workflowId: `on-complete-${input.sourceContext.label}`,
          args: [input.result.value],
        });
      },
    }),
  });
  const worker = await createWorker({ nexusServices: [...makeHandlers().handlers, workflowHandler] });

  await worker.runUntil(async () => {
    const client = t.context.env.client;
    const svc = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    const result = await svc.executeOperation('echo', 'hello', {
      id: 'op-' + randomUUID(),
      scheduleToCloseTimeout: '10s',
      completionCallbacks: [
        createCompletionCallback({
          service: workflowNotificationService,
          operation: workflowNotificationService.operations.onComplete,
          taskQueue: worker.options.taskQueue,
          sourceContext: { label },
        }),
      ],
    });
    t.deepEqual(result, { value: 'hello' });

    const handle = client.workflow.getHandle(`on-complete-${label}`);
    await waitUntil(
      () =>
        handle.describe().then(
          () => true,
          () => false
        ),
      10_000
    );
    t.deepEqual(await handle.result(), {});
    const history = await handle.fetchHistory();
    t.true(history.events!.some((event) => event.links?.some((link) => link.callback != null)));
  });
});

for (const outcome of ['success', 'failure'] as const) {
  test(`typed on-complete operation round-trips ${outcome} through a payload codec`, async (t) => {
    const { createWorker, registerNexusEndpoint } = helpers(t);
    const { endpointName } = await registerNexusEndpoint();
    const { requests, handlers } = makeHandlers();
    const worker = await createWorker({ nexusServices: handlers, dataConverter: { payloadCodecs: [prefixCodec] } });
    const client = new Client({
      connection: t.context.env.connection,
      namespace: t.context.env.namespace,
      dataConverter: { payloadCodecs: [prefixCodec] },
    });

    await worker.runUntil(async () => {
      const svc = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
      const options = {
        id: 'op-' + randomUUID(),
        scheduleToCloseTimeout: '10s',
        completionCallbacks: [
          createCompletionCallback({
            service: notificationService.name,
            operation: 'OnComplete',
            taskQueue: worker.options.taskQueue,
            sourceContext: { label: 'codec' },
          }),
        ],
      } as const;
      if (outcome === 'success') {
        t.deepEqual(await svc.executeOperation('echo', 'encoded', options), { value: 'encoded' });
      } else {
        await t.throwsAsync(svc.executeOperation('fail', 'encoded failure', options), {
          instanceOf: NexusOperationFailureError,
        });
      }

      await waitUntil(async () => requests.has('codec'), 10_000);
      const request = requests.get('codec')!;
      t.deepEqual(request.sourceContext, { label: 'codec' });
      if (outcome === 'success') {
        t.deepEqual(request.result, { tag: 'success', value: { value: 'encoded' } });
      } else {
        t.is(request.result.tag, 'failure');
        const failure = request.result.value;
        t.true(failure instanceof ApplicationFailure);
        t.is((failure as ApplicationFailure).message, 'encoded failure');
        // Failure details can only be read if the Worker decoded them with the codec
        t.deepEqual((failure as ApplicationFailure).details, ['detail']);
      }
    });
  });
}

test('RawValue on-complete operation receives a result decoded by the payload codec', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  const { requests, handler: rawHandler } = makeRawHandler();
  const dataConverter = { payloadCodecs: [prefixCodec] };
  const worker = await createWorker({ nexusServices: [...makeHandlers().handlers, rawHandler], dataConverter });
  const client = new Client({
    connection: t.context.env.connection,
    namespace: t.context.env.namespace,
    dataConverter,
  });

  await worker.runUntil(async () => {
    const svc = client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    await svc.executeOperation('echo', 'raw', {
      id: 'op-' + randomUUID(),
      scheduleToCloseTimeout: '10s',
      completionCallbacks: [
        createCompletionCallback({
          service: rawNotificationService.name,
          operation: 'onComplete',
          taskQueue: worker.options.taskQueue,
          sourceContext: { label: 'raw' },
        }),
      ],
    });

    await waitUntil(async () => requests.has('raw'), 10_000);
    const request = requests.get('raw')!;
    t.deepEqual(request.sourceContext, { label: 'raw' });
    t.is(request.result.tag, 'success');
    t.true(request.result.value instanceof RawValue);
    const raw = (request.result.value as RawValue).payload;
    // The Worker runs the codec before handing the handler the raw payload
    t.not(decode(raw.metadata!.encoding!), 'test/prefix');
    t.deepEqual(defaultPayloadConverter.fromPayload(raw), { value: 'raw' });
  });
});

test('completion callback applies source context TypeInfo', async (t) => {
  const { createWorker, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();
  // The handler receives a number, but the payload carries it as a string
  const sourceContextType: TypeInfo<number, string> = {
    transferTypeConverter: {
      toTransferType: (value) => `n:${value}`,
      fromTransferType: (value) => Number(value.slice(2)),
    },
  };
  const typedNotificationService = nexus.service('callback.test.TypedNotificationService', {
    onComplete: nexus.operation<OnCompleteRequest<{ value: string }, number>, OnCompleteResponse>({
      inputType: {
        transferTypeConverter: createOnCompleteRequestTransferTypeConverter<{ value: string }, number>({
          sourceContextT: sourceContextType,
        }),
      },
      outputType: { transferTypeConverter: onCompleteResponseTransferTypeConverter },
    }),
  });
  const sourceContexts: number[] = [];
  const typedHandler = nexus.serviceHandler(typedNotificationService, {
    async onComplete(_ctx, input) {
      sourceContexts.push(input.sourceContext);
      return {};
    },
  });
  const worker = await createWorker({ nexusServices: [...makeHandlers().handlers, typedHandler] });

  await worker.runUntil(async () => {
    const svc = t.context.env.client.nexus.createServiceClient({ endpoint: endpointName, service: testService });
    await svc.executeOperation('echo', 'typed', {
      id: 'op-' + randomUUID(),
      scheduleToCloseTimeout: '10s',
      completionCallbacks: [
        createCompletionCallback({
          service: typedNotificationService,
          operation: typedNotificationService.operations.onComplete,
          taskQueue: worker.options.taskQueue,
          sourceContext: 7,
          sourceContextType,
        }),
      ],
    });

    await waitUntil(async () => sourceContexts.length > 0, 10_000);
    t.is(sourceContexts[0], 7);
  });
});
