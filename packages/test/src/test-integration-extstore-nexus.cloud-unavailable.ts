/**
 * External storage integration tests for Nexus operations.
 *
 * Lives in its own file (rather than test-integration-extstore.ts) because the caller workflow must
 * be in the bundled workflows and share the Nexus service definition with the handler.
 */
import * as nexus from 'nexus-rpc';
import { ExternalStorage } from '@temporalio/common';
import { makeFakeDriver } from './extstore-fake-driver';
import { helpers, makeTestFunction } from './helpers-integration';
import {
  extstoreNexusBigResultCaller,
  extstoreNexusSizeCaller,
  nexusSizeService,
} from './workflows/integration-extstore-nexus';

const test = makeTestFunction({});

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
