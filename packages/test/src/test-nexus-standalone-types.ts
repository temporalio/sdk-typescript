import test from 'ava';
import * as nexus from 'nexus-rpc';
import type { Client, NexusOperationHandle } from '@temporalio/client';

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
  }
  t.pass();
});

test('Different operation in the same service infers different types', async (t) => {
  async function _assertion() {
    const nexusClient = client.nexus.createServiceClient({
      endpoint: 'my-endpoint',
      service: myService,
    });

    const _numberOutput: number = await nexusClient.executeOperation(myService.operations.myOtherOp, 'input-string', {
      id: 'op-1',
      scheduleToCloseTimeout: '10s',
    });
  }
  t.pass();
});

test('getHandle with string defaults to unknown', (t) => {
  function _assertion() {
    const _anyHandle: NexusOperationHandle<unknown> = client.nexus.getHandle('op-1');
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
  }
  t.pass();
});
