import test from 'ava';
import * as nexus from 'nexus-rpc';
import { Client as ClientImpl, createCompletionCallback } from '@temporalio/client';
import type {
  Client,
  CompletionCallback,
  ConnectionLike,
  GetNexusOperationHandleOptions,
  NexusOperationHandle,
  NexusOperationHandleDefinitionOptions,
} from '@temporalio/client';
import { defaultPayloadConverter, type RawValue, type SerializationContext, type TypeInfo } from '@temporalio/common';
import type { temporal } from '@temporalio/proto';
import type { OnCompleteRequest, OnCompleteResponse } from '@temporalio/nexus/notifications';

interface MyInput {
  value: string;
}

interface MyOutput {
  result: string;
}

interface CallbackContext {
  label: string;
}

const myService = nexus.service('myService', {
  mySyncOp: nexus.operation<MyInput, MyOutput>(),
  myOtherOp: nexus.operation<string, number>(),
});

const otherService = nexus.service('otherService', {
  stringOp: nexus.operation<string, string>(),
});

declare const client: Client;
declare const numberTypeInfo: TypeInfo<number>;

test('executeOperation with operation definition infers output type', async (t) => {
  async function _assertion() {
    const nexusClient = client.nexus.createServiceClient({
      endpoint: 'my-endpoint',
      service: myService,
    });

    const _output: MyOutput = await nexusClient.executeOperation(
      myService.operations.mySyncOp,
      { value: 'hello' },
      { id: 'op-1', scheduleToCloseTimeout: '10s' }
    );
  }

  t.pass();
});

test('executeOperation with key-based lookup infers output type', async (t) => {
  async function _assertion() {
    const nexusClient = client.nexus.createServiceClient({
      endpoint: 'my-endpoint',
      service: myService,
    });

    const _output: MyOutput = await nexusClient.executeOperation(
      'mySyncOp',
      { value: 'hello' },
      { id: 'op-1', scheduleToCloseTimeout: '10s' }
    );
  }
  t.pass();
});

test('startOperation + handle.result() preserves type', async (t) => {
  async function _assertion() {
    const nexusClient = client.nexus.createServiceClient({
      endpoint: 'my-endpoint',
      service: myService,
    });

    const _handle: NexusOperationHandle<MyOutput> = await nexusClient.startOperation(
      myService.operations.mySyncOp,
      { value: 'hello' },
      { id: 'op-1', scheduleToCloseTimeout: '10s' }
    );
    const _handleOutput: MyOutput = await _handle.result();

    const _handleByKey: NexusOperationHandle<MyOutput> = await nexusClient.startOperation(
      'mySyncOp',
      { value: 'hello' },
      { id: 'op-1', scheduleToCloseTimeout: '10s' }
    );
    const _handleByKeyOutput: MyOutput = await _handleByKey.result();
  }
  t.pass();
});

test('getHandle with no type defaults to unknown', (t) => {
  function _assertion() {
    const _anyHandle: NexusOperationHandle<unknown> = client.nexus.getHandle('op-1');
    const options: GetNexusOperationHandleOptions = { runId: 'run-id' };
    const _typedHandle: NexusOperationHandle<MyOutput> = client.nexus.getHandle<MyOutput>('op-1', options);
    const _indexedOptions: GetNexusOperationHandleOptions<MyOutput> & Record<string, unknown> = {
      runId: 'run-id',
      // @ts-expect-error An index signature cannot hide an Operation definition in non-definition options.
      operation: myService.operations.mySyncOp,
    };
    function getNexusHandleFromGeneric<O extends GetNexusOperationHandleOptions<MyOutput>>(genericOptions: O) {
      return client.nexus.getHandle<MyOutput>('op-1', genericOptions);
    }
    void getNexusHandleFromGeneric({
      runId: 'run-id',
      // @ts-expect-error A generic constraint cannot hide an Operation definition in non-definition options.
      operation: myService.operations.mySyncOp,
    });
  }
  t.pass();
});

test('getHandle with generic type parameter infers correctly', async (t) => {
  async function _assertion() {
    const _typedHandle: NexusOperationHandle<MyOutput> = client.nexus.getHandle<MyOutput>('op-1');
    const _typedOutput: MyOutput = await _typedHandle.result();

    const _typedHandleFromOp: NexusOperationHandle<MyOutput> =
      client.nexus.getHandle<typeof myService.operations.mySyncOp>('op-1');
    const _typedOutputFromOp: MyOutput = await _typedHandleFromOp.result();

    void client.nexus.getHandle<MyOutput>('op-1', {
      typeInfo: {
        // @ts-expect-error Explicit TypeInfo must produce the handle result type.
        outputType: numberTypeInfo,
      },
    });
  }
  t.pass();
});

test('getHandle with operation definition infers correctly', async (t) => {
  async function _assertion() {
    const options = { operation: myService.operations.mySyncOp };
    const _typedHandle = client.nexus.getHandle('op-1', options);
    const _typedOutput: MyOutput = await _typedHandle.result();
    const reusableDefinitionOptions: NexusOperationHandleDefinitionOptions<typeof myService.operations.mySyncOp> = {
      operation: myService.operations.mySyncOp,
    };
    const _reusableDefinitionHandle: NexusOperationHandle<MyOutput> = client.nexus.getHandle(
      'op-1',
      reusableDefinitionOptions
    );

    // @ts-expect-error Supplying an Operation definition selects definition-based result inference.
    void client.nexus.getHandle<string>('op-1', reusableDefinitionOptions);

    // @ts-expect-error Supplying an Operation definition selects definition-based result inference.
    void client.nexus.getHandle<string>('op-1', options);

    // @ts-expect-error Operation definitions and call-site TypeInfo are mutually exclusive.
    void client.nexus.getHandle('op-1', { operation: myService.operations.mySyncOp, typeInfo: {} });
  }
  t.pass();
});

test('executeOperation with wrong input type produces type error', async (t) => {
  async function _assertion() {
    const nexusClient = client.nexus.createServiceClient({
      endpoint: 'my-endpoint',
      service: myService,
    });

    // @ts-expect-error - input must be MyInput, not string
    await nexusClient.executeOperation(myService.operations.mySyncOp, 'wrong-input-type', {
      id: 'op-1',
      scheduleToCloseTimeout: '10s',
    });

    // @ts-expect-error - input must be MyInput, not string
    await nexusClient.executeOperation('mySyncOp', 'wrong-input-type', {
      id: 'op-1',
      scheduleToCloseTimeout: '10s',
    });
  }
  t.pass();
});

test('startOperation with wrong input type produces type error', async (t) => {
  async function _assertion() {
    const nexusClient = client.nexus.createServiceClient({
      endpoint: 'my-endpoint',
      service: myService,
    });

    // @ts-expect-error - input must be MyInput, not string
    await nexusClient.startOperation(myService.operations.mySyncOp, 'wrong-input-type', {
      id: 'op-1',
      scheduleToCloseTimeout: '10s',
    });

    // @ts-expect-error - input must be MyInput, not string
    await nexusClient.startOperation('mySyncOp', 'wrong-input-type', {
      id: 'op-1',
      scheduleToCloseTimeout: '10s',
    });
  }
  t.pass();
});

test('Operation from a different service produces type error', async (t) => {
  async function _assertion() {
    const nexusClient = client.nexus.createServiceClient({
      endpoint: 'my-endpoint',
      service: myService,
    });

    // @ts-expect-error - otherService.stringOp is not an operation of myService
    await nexusClient.executeOperation(otherService.operations.stringOp, 'hello', {
      id: 'op-1',
      scheduleToCloseTimeout: '10s',
    });
  }
  t.pass();
});

test('Mismatched result type on handle produces type error', async (t) => {
  async function _assertion() {
    const nexusClient = client.nexus.createServiceClient({
      endpoint: 'my-endpoint',
      service: myService,
    });

    // @ts-expect-error - Type 'NexusOperationHandle<MyOutput>' not assignable to 'NexusOperationHandle<string>'
    const _badHandle: NexusOperationHandle<string> = await nexusClient.startOperation(
      myService.operations.mySyncOp,
      { value: 'hello' },
      { id: 'op-1', scheduleToCloseTimeout: '10s' }
    );

    // @ts-expect-error - Type 'NexusOperationHandle<MyOutput>' not assignable to 'NexusOperationHandle<string>'
    const _badHandleByKey: NexusOperationHandle<string> = await nexusClient.startOperation(
      'mySyncOp',
      { value: 'hello' },
      { id: 'op-1', scheduleToCloseTimeout: '10s' }
    );
  }
  t.pass();
});

test('Union of operation output types produces type error', async (t) => {
  async function _assertion(op: 'mySyncOp' | typeof myService.operations.myOtherOp) {
    const nexusClient = client.nexus.createServiceClient({
      endpoint: 'my-endpoint',
      service: myService,
    });

    // @ts-expect-error - No overload matches this call
    const _output: MyOutput | number = await nexusClient.executeOperation(op, 'string-only-input', {
      id: 'op-1',
      scheduleToCloseTimeout: '10s',
    });
  }
  t.pass();
});

test('Mismatched output type on execute produces type error', async (t) => {
  async function _assertion() {
    const nexusClient = client.nexus.createServiceClient({
      endpoint: 'my-endpoint',
      service: myService,
    });

    // @ts-expect-error - Type 'MyOutput' not assignable to 'string'
    const _badOutput: string = await nexusClient.executeOperation(
      myService.operations.mySyncOp,
      { value: 'hello' },
      { id: 'op-1', scheduleToCloseTimeout: '10s' }
    );

    // @ts-expect-error - Type 'MyOutput' not assignable to 'string'
    const _badOutputByKey: string = await nexusClient.executeOperation(
      'mySyncOp',
      { value: 'hello' },
      { id: 'op-1', scheduleToCloseTimeout: '10s' }
    );
  }
  t.pass();
});

test('Missing required id option produces type error', async (t) => {
  async function _assertion() {
    const nexusClient = client.nexus.createServiceClient({
      endpoint: 'my-endpoint',
      service: myService,
    });

    const operation = myService.operations.mySyncOp;
    // @ts-expect-error - id is required
    await nexusClient.executeOperation(operation, { value: 'hello' }, { scheduleToCloseTimeout: '10s' });

    // @ts-expect-error - id is required
    await nexusClient.executeOperation('mySyncOp', { value: 'hello' }, { scheduleToCloseTimeout: '10s' });
  }
  t.pass();
});

const notificationService = nexus.service('notificationService', {
  onMyOutput: nexus.operation<OnCompleteRequest<MyOutput, CallbackContext>, OnCompleteResponse>({ name: 'OnMyOutput' }),
  onAnything: nexus.operation<OnCompleteRequest<unknown, CallbackContext>, OnCompleteResponse>(),
  onRawValue: nexus.operation<OnCompleteRequest<RawValue, CallbackContext>, OnCompleteResponse>(),
  notOnComplete: nexus.operation<string, string>(),
});

test('completion callbacks must accept the operation output type', async (t) => {
  async function _assertion() {
    const nexusClient = client.nexus.createServiceClient({ endpoint: 'my-endpoint', service: myService });
    const onMyOutput = createCompletionCallback({
      service: notificationService,
      operation: notificationService.operations.onMyOutput,
      taskQueue: 'tq',
      sourceContext: { label: 'a' },
    });
    const _typed: CompletionCallback<MyOutput> = onMyOutput;
    const onAnything = createCompletionCallback({
      service: notificationService,
      operation: notificationService.operations.onAnything,
      taskQueue: 'tq',
      sourceContext: { label: 'a' },
    });
    const onRawValue = createCompletionCallback({
      service: notificationService,
      operation: notificationService.operations.onRawValue,
      taskQueue: 'tq',
      sourceContext: { label: 'a' },
    });
    const byName = createCompletionCallback({ service: 's', operation: 'o', taskQueue: 'tq', sourceContext: 1 });

    await nexusClient.startOperation(
      myService.operations.mySyncOp,
      { value: 'v' },
      {
        id: 'op-1',
        completionCallbacks: [onMyOutput, onAnything, onRawValue, byName],
      }
    );
    await nexusClient.executeOperation('mySyncOp', { value: 'v' }, { id: 'op-1', completionCallbacks: [onMyOutput] });
    await nexusClient.executeOperation('myOtherOp', 'v', {
      id: 'op-1',
      completionCallbacks: [onAnything, onRawValue, byName],
    });
    // @ts-expect-error callback accepts MyOutput but operation returns number
    await nexusClient.executeOperation('myOtherOp', 'v', { id: 'op-1', completionCallbacks: [onMyOutput] });
    const wrongOutput = { id: 'op-1', completionCallbacks: [onMyOutput] };
    // @ts-expect-error callback accepts MyOutput but operation returns number
    await nexusClient.startOperation(myService.operations.myOtherOp, 'v', wrongOutput);
    const service = notificationService;
    const wrongContext = { service, operation: service.operations.onMyOutput, taskQueue: 'tq', sourceContext: 'x' };
    // @ts-expect-error source context must match the on-complete operation
    createCompletionCallback(wrongContext);
    const wrongRawContext = { service, operation: service.operations.onRawValue, taskQueue: 'tq', sourceContext: 'x' };
    // @ts-expect-error source context must match the on-complete operation
    createCompletionCallback(wrongRawContext);
    const notOnComplete = { service, operation: service.operations.notOnComplete, taskQueue: 'tq', sourceContext: {} };
    // @ts-expect-error operation must be an on-complete operation
    createCompletionCallback(notOnComplete);
  }

  t.pass();
});

test('createCompletionCallback resolves names from definitions', (t) => {
  t.deepEqual(
    createCompletionCallback({
      service: notificationService,
      operation: notificationService.operations.onMyOutput,
      taskQueue: 'tq',
      sourceContext: { label: 'a' },
    }),
    {
      service: 'notificationService',
      operation: 'OnMyOutput',
      taskQueue: 'tq',
      sourceContext: { label: 'a' },
      sourceContextType: undefined,
    }
  );
  t.deepEqual(createCompletionCallback({ service: 's', operation: 'o', taskQueue: 'tq', sourceContext: null }), {
    service: 's',
    operation: 'o',
    taskQueue: 'tq',
    sourceContext: null,
    sourceContextType: undefined,
  });
});

test('createCompletionCallback rejects invalid arguments', (t) => {
  t.throws(
    () =>
      createCompletionCallback({
        service: otherService,
        operation: notificationService.operations.onMyOutput,
        taskQueue: 'tq',
        sourceContext: { label: 'a' },
      }),
    { instanceOf: TypeError, message: /not an operation of service otherService/ }
  );
  // An operation from another service fails even when the names match
  const lookalikeService = nexus.service('lookalikeService', {
    onMyOutput: nexus.operation<OnCompleteRequest<MyOutput, CallbackContext>, OnCompleteResponse>({
      name: 'OnMyOutput',
    }),
  });
  t.throws(
    () =>
      createCompletionCallback({
        service: lookalikeService,
        operation: notificationService.operations.onMyOutput,
        taskQueue: 'tq',
        sourceContext: { label: 'a' },
      }),
    { instanceOf: TypeError, message: /not an operation of service lookalikeService/ }
  );
  for (const [service, operation, taskQueue] of [
    ['', 'o', 'tq'],
    ['s', '', 'tq'],
    ['s', 'o', ''],
  ]) {
    t.throws(() => createCompletionCallback({ service, operation, taskQueue, sourceContext: 1 }), {
      instanceOf: TypeError,
      message: /must not be empty/,
    });
  }
});

test('completion callback source context is encoded with the started operation context', async (t) => {
  const codecContexts: (SerializationContext | undefined)[] = [];
  let request: temporal.api.workflowservice.v1.IStartNexusOperationExecutionRequest | undefined;
  const connection = {
    workflowService: {
      startNexusOperationExecution: async (
        req: temporal.api.workflowservice.v1.IStartNexusOperationExecutionRequest
      ) => {
        request = req;
        return { runId: 'run-id' };
      },
    },
    plugins: [],
  } as unknown as ConnectionLike;
  const recordingClient = new ClientImpl({
    connection,
    dataConverter: {
      payloadCodecs: [
        {
          async encode(payloads, context) {
            codecContexts.push(context);
            return payloads;
          },
          async decode(payloads) {
            return payloads;
          },
        },
      ],
    },
  });

  await recordingClient.nexus
    .createServiceClient({ endpoint: 'source-endpoint', service: myService })
    .startOperation(myService.operations.myOtherOp, 'input', {
      id: 'op-1',
      completionCallbacks: [
        createCompletionCallback({
          service: 'Notifications',
          operation: 'OnComplete',
          taskQueue: 'tq',
          sourceContext: 'ctx',
        }),
      ],
    });

  const sourceContext: SerializationContext = {
    type: 'nexus',
    endpoint: 'source-endpoint',
    service: 'myService',
    operation: 'myOtherOp',
  };
  // One encode for the operation input, one for the callback source context
  t.deepEqual(codecContexts, [sourceContext, sourceContext]);
  const handler = request?.completionCallbacks?.[0]?.nexusHandler;
  t.like(handler, { service: 'Notifications', operation: 'OnComplete', taskQueueName: 'tq' });
  t.is(defaultPayloadConverter.fromPayload(handler!.sourceContext!), 'ctx');
});
