/**
 * The namespace of the storing client reaches the select and store contexts on client paths,
 * with or without a target. Uses a stub connection, so no server is needed.
 */
import test from 'ava';
import * as nexus from 'nexus-rpc';
import type { ConnectionLike } from '@temporalio/client';
import { Client } from '@temporalio/client';
import { ExternalStorage, type StorageDriverSelectContext } from '@temporalio/common';
import { makeFakeDriver } from './extstore-fake-driver';

const CLIENT_NAMESPACE = 'client-ns';

function makeClient(workflowService: Record<string, (req: unknown) => Promise<unknown>>) {
  const driver = makeFakeDriver();
  const selectContexts: StorageDriverSelectContext[] = [];
  const externalStorage = new ExternalStorage({
    drivers: [driver],
    driverSelector: (context) => {
      selectContexts.push(context);
      return driver;
    },
    payloadSizeThreshold: 1024,
  });
  const connection = { workflowService, plugins: [] } as unknown as ConnectionLike;
  const client = new Client({
    connection,
    namespace: CLIENT_NAMESPACE,
    dataConverter: { externalStorage },
    payloadCache: false,
  });
  return { client, driver, selectContexts };
}

const largeArg = (): Uint8Array => new Uint8Array(4096).fill(7);

test('workflow start passes the client namespace alongside the target', async (t) => {
  const { client, driver, selectContexts } = makeClient({
    startWorkflowExecution: async () => ({ runId: 'run-1' }),
  });

  await client.workflow.start('myWorkflow', { workflowId: 'wf-1', taskQueue: 'q', args: [largeArg()] });

  t.is(selectContexts.length, 1);
  t.is(selectContexts[0]!.namespace, CLIENT_NAMESPACE);
  t.is(selectContexts[0]!.target?.kind, 'workflow');
  t.is(driver.storeCalls.length, 1);
  t.is(driver.storeCalls[0]!.context.namespace, CLIENT_NAMESPACE);
});

test('async completion by task token passes the client namespace', async (t) => {
  const { client, driver, selectContexts } = makeClient({
    respondActivityTaskCompleted: async () => ({}),
  });

  await client.activity.complete(new Uint8Array([1]), largeArg());

  t.is(selectContexts.length, 1);
  t.is(selectContexts[0]!.namespace, CLIENT_NAMESPACE);
  t.is(driver.storeCalls.length, 1);
  t.is(driver.storeCalls[0]!.context.namespace, CLIENT_NAMESPACE);
});

test('schedule memo passes the client namespace', async (t) => {
  const { client, driver, selectContexts } = makeClient({
    createSchedule: async () => ({}),
  });

  await client.schedule.create({
    scheduleId: 'sched-1',
    spec: {},
    action: { type: 'startWorkflow', workflowType: 'w', taskQueue: 'q' },
    memo: { blob: largeArg() },
  });

  t.is(selectContexts.length, 1);
  t.is(selectContexts[0]!.namespace, CLIENT_NAMESPACE);
  t.is(driver.storeCalls.length, 1);
  t.is(driver.storeCalls[0]!.context.namespace, CLIENT_NAMESPACE);
});

test('Nexus operation start has no target but passes the client namespace', async (t) => {
  const { client, driver, selectContexts } = makeClient({
    startNexusOperationExecution: async () => ({ runId: 'run-1' }),
  });
  const service = nexus.service('svc', { op: nexus.operation<Uint8Array, string>() });

  await client.nexus
    .createServiceClient({ endpoint: 'endpoint', service })
    .startOperation(service.operations.op, largeArg(), { id: 'op-1', scheduleToCloseTimeout: '1 minute' });

  t.is(selectContexts.length, 1);
  t.is(selectContexts[0]!.target, undefined);
  t.is(selectContexts[0]!.namespace, CLIENT_NAMESPACE);
  t.is(driver.storeCalls.length, 1);
  t.is(driver.storeCalls[0]!.context.target, undefined);
  t.is(driver.storeCalls[0]!.context.namespace, CLIENT_NAMESPACE);
});
