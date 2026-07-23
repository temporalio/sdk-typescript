/**
 * External storage integration tests for Nexus operations.
 *
 * Lives in its own file (rather than test-integration-extstore.ts) because the caller workflow must
 * be in the bundled workflows and share the Nexus service definition with the handler, so this uses
 * `workflowsPath: __filename` like the other Nexus caller tests.
 */
import * as nexus from 'nexus-rpc';
import { ExternalStorage } from '@temporalio/common';
import * as workflow from '@temporalio/workflow';
import { makeFakeDriver } from './extstore-fake-driver';
import { helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({ workflowsPath: __filename });

const nexusSizeService = nexus.service('extstoreNexusSizeService', {
  // Takes a payload and returns its length, so a large input can be offloaded and the handler's
  // observed length proves it was retrieved intact.
  sizeOp: nexus.operation<Uint8Array, number>(),
  // Takes a size and returns a payload of that size, so a large (sync) result can be offloaded and
  // the caller's observed length proves it was retrieved intact.
  bigResultOp: nexus.operation<number, Uint8Array>(),
});

export async function extstoreNexusSizeCaller(endpoint: string, sizeBytes: number): Promise<number> {
  const client = workflow.createNexusServiceClient({ endpoint, service: nexusSizeService });
  return await client.executeOperation('sizeOp', new Uint8Array(sizeBytes));
}

export async function extstoreNexusBigResultCaller(endpoint: string, sizeBytes: number): Promise<number> {
  const client = workflow.createNexusServiceClient({ endpoint, service: nexusSizeService });
  const result = await client.executeOperation('bigResultOp', sizeBytes);
  return result.length;
}

function sizeServiceHandler() {
  return nexus.serviceHandler(nexusSizeService, {
    async sizeOp(_ctx, input) {
      return input.length;
    },
    async bigResultOp(_ctx, size) {
      return new Uint8Array(size);
    },
  });
}

test('nexus operation input is offloaded and retrieved for the handler invocation', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const driver = makeFakeDriver();
  const payloadSize = 4096;
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });

  const worker = await createWorker({
    dataConverter: { externalStorage },
    nexusServices: [sizeServiceHandler()],
  });

  const handle = await startWorkflow(extstoreNexusSizeCaller, { args: [endpointName, payloadSize] });
  const len = await worker.runUntil(handle.result());

  // The handler observed the full input, so the caller's operation input was offloaded on the
  // outbound command and retrieved when the worker delivered the Nexus task.
  t.is(len, payloadSize);
  t.is(driver.storeCalls.length, 1);
  t.is(driver.retrieveCalls.length, 1);
});

test('nexus operation sync result is offloaded and retrieved for the caller', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  const driver = makeFakeDriver();
  const payloadSize = 4096;
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });

  const worker = await createWorker({
    dataConverter: { externalStorage },
    nexusServices: [sizeServiceHandler()],
  });

  const handle = await startWorkflow(extstoreNexusBigResultCaller, { args: [endpointName, payloadSize] });
  const len = await worker.runUntil(handle.result());

  // The caller observed the full result, so the handler's sync result was offloaded on the Nexus task
  // completion and retrieved when it landed in the caller's workflow activation.
  t.is(len, payloadSize);
  t.is(driver.storeCalls.length, 1);
  t.is(driver.retrieveCalls.length, 1);
});

test('a transient retrieve failure on the Nexus task fails it retryably and recovers', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  // Fail the first retrieve of the handler's input, then behave normally.
  const driver = makeFakeDriver({ failFirstRetrieve: true });
  const payloadSize = 4096;
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });

  const worker = await createWorker({
    dataConverter: { externalStorage },
    nexusServices: [sizeServiceHandler()],
  });

  const handle = await startWorkflow(extstoreNexusSizeCaller, { args: [endpointName, payloadSize] });
  const len = await worker.runUntil(handle.result());

  // The retrieve failure failed the Nexus task retryably (the worker stayed alive); the operation was
  // retried, the retrieve succeeded, and the caller got the result.
  t.is(len, payloadSize);
  t.true(driver.retrieveCalls.length >= 2); // failed once, then succeeded on the retry
});

test('a transient store failure on the Nexus result fails it retryably and recovers', async (t) => {
  const { createWorker, startWorkflow, registerNexusEndpoint } = helpers(t);
  const { endpointName } = await registerNexusEndpoint();

  // Fail the first store of the handler's result, then behave normally.
  const driver = makeFakeDriver({ failFirstStore: true });
  const payloadSize = 4096;
  const externalStorage = new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 });

  const worker = await createWorker({
    dataConverter: { externalStorage },
    nexusServices: [sizeServiceHandler()],
  });

  const handle = await startWorkflow(extstoreNexusBigResultCaller, { args: [endpointName, payloadSize] });
  const len = await worker.runUntil(handle.result());

  // The store failure failed the Nexus task retryably (the worker stayed alive); the operation was
  // retried, the store succeeded, and the caller got the result.
  t.is(len, payloadSize);
  t.true(driver.storeCalls.length >= 2); // failed once, then succeeded on the retry
});
