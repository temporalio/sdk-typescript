import test from 'ava';
import * as nexus from 'nexus-rpc';
import type {
  Client,
  GetNexusOperationHandleOptions,
  NexusOperationHandle,
  NexusOperationHandleDefinitionOptions,
} from '@temporalio/client';
import type { TypeInfo } from '@temporalio/common';

interface MyInput {
  value: string;
}

interface MyOutput {
  result: string;
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
    void client.nexus.getHandle('op-1', {
      operation: myService.operations.mySyncOp,
      typeInfo: {},
    });
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

    // @ts-expect-error - id is required
    await nexusClient.executeOperation(
      myService.operations.mySyncOp,
      { value: 'hello' },
      {
        scheduleToCloseTimeout: '10s',
      }
    );

    // @ts-expect-error - id is required
    await nexusClient.executeOperation('mySyncOp', { value: 'hello' }, { scheduleToCloseTimeout: '10s' });
  }
  t.pass();
});
