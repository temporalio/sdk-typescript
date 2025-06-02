import { randomUUID } from 'node:crypto';
import test from 'ava';
import { Client, Connection, Metadata } from '@temporalio/client';
import { CloudOperationsClient, CloudOperationsConnection } from '@temporalio/cloud';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as workflows from './workflows';

test('Can connect to Temporal Cloud using mTLS', async (t) => {
  const address = process.env.TEMPORAL_CLOUD_MTLS_TEST_TARGET_HOST;
  const namespace = process.env.TEMPORAL_CLOUD_MTLS_TEST_NAMESPACE;
  const clientCert = process.env.TEMPORAL_CLOUD_MTLS_TEST_CLIENT_CERT;
  const clientKey = process.env.TEMPORAL_CLOUD_MTLS_TEST_CLIENT_KEY;

  if (!address || !namespace || !clientCert || !clientKey) {
    t.pass('Skipping: No Temporal Cloud mTLS connection details provided');
    return;
  }

  const connection = await Connection.connect({
    address,
    tls: {
      clientCertPair: {
        crt: Buffer.from(clientCert),
        key: Buffer.from(clientKey),
      },
    },
  });
  const client = new Client({ connection, namespace });

  const nativeConnection = await NativeConnection.connect({
    address,
    tls: {
      clientCertPair: {
        crt: Buffer.from(clientCert),
        key: Buffer.from(clientKey),
      },
    },
  });
  const nativeClient = new Client({ connection: nativeConnection, namespace });

  const taskQueue = `test-temporal-cloud-mtls-${randomUUID()}`;
  const worker = await Worker.create({
    namespace,
    workflowsPath: require.resolve('./workflows'),
    connection: nativeConnection,
    taskQueue,
  });

  const [res1, res2] = await worker.runUntil(async () => {
    return Promise.all([
      client.workflow.execute(workflows.successString, {
        workflowId: randomUUID(),
        taskQueue,
      }),
      nativeClient.workflow.execute(workflows.successString, {
        workflowId: randomUUID(),
        taskQueue,
      }),
    ]);
  });

  t.is(res1, 'success');
  t.is(res2, 'success');
});

test('Can connect to Temporal Cloud using API Keys', async (t) => {
  const address = process.env.TEMPORAL_CLOUD_API_KEY_TEST_TARGET_HOST;
  const namespace = process.env.TEMPORAL_CLOUD_API_KEY_TEST_NAMESPACE;
  const apiKey = process.env.TEMPORAL_CLOUD_API_KEY_TEST_API_KEY;

  if (!address || !namespace || !apiKey) {
    t.pass('Skipping: No Temporal Cloud API Key connection details provided');
    return;
  }

  const connection = await Connection.connect({
    address,
    apiKey,
    tls: true,
  });
  const client = new Client({ connection, namespace });

  const nativeConnection = await NativeConnection.connect({
    address,
    apiKey,
    tls: true,
  });
  const nativeClient = new Client({ connection: nativeConnection, namespace });

  const taskQueue = `test-temporal-cloud-api-key-${randomUUID()}`;
  const worker = await Worker.create({
    namespace,
    workflowsPath: require.resolve('./workflows'),
    connection: nativeConnection,
    taskQueue,
  });

  const [res1, res2] = await worker.runUntil(async () => {
    return Promise.all([
      client.workflow.execute(workflows.successString, {
        workflowId: randomUUID(),
        taskQueue,
      }),
      nativeClient.workflow.execute(workflows.successString, {
        workflowId: randomUUID(),
        taskQueue,
      }),
    ]);
  });

  t.is(res1, 'success');
  t.is(res2, 'success');
});

test('Can create connection to Temporal Cloud Operation service', async (t) => {
  const address = process.env.TEMPORAL_CLOUD_OPS_TEST_TARGET_HOST;
  const namespace = process.env.TEMPORAL_CLOUD_OPS_TEST_NAMESPACE;
  const apiKey = process.env.TEMPORAL_CLOUD_OPS_TEST_API_KEY;
  const apiVersion = process.env.TEMPORAL_CLOUD_OPS_TEST_API_VERSION;

  if (!address || !namespace || !apiKey || !apiVersion) {
    t.pass('Skipping: No Cloud Operations connection details provided');
    return;
  }

  const connection = await CloudOperationsConnection.connect({
    address,
    apiKey,
  });
  const client = new CloudOperationsClient({ connection, apiVersion });

  const metadata: Metadata = {};
  if (apiVersion) {
    metadata['temporal-cloud-api-version'] = apiVersion;
  }

  // Note that the Cloud Operations client does not automatically inject the namespace header.
  // This is intentional, as the Cloud Operations Client is a temporary API and will be moved
  // to a different owner package in the near future.
  const response = await client.withMetadata(metadata, async () => {
    return client.cloudService.getNamespace({ namespace });
  });
  t.is(response?.namespace?.namespace, namespace);
});
