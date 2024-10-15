import test from 'ava';
import { Metadata } from '@temporalio/client';
import { CloudOperationsClient, CloudOperationsConnection } from '@temporalio/cloud';

test('Can create connection to Temporal Cloud Operation service', async (t) => {
  const address = process.env.TEMPORAL_CLOUD_SAAS_ADDRESS ?? 'saas-api.tmprl.cloud:443';
  const apiKey = process.env.TEMPORAL_CLIENT_CLOUD_API_KEY;
  const apiVersion = process.env.TEMPORAL_CLIENT_CLOUD_API_VERSION;
  const namespace = process.env.TEMPORAL_CLIENT_CLOUD_NAMESPACE;

  if (!apiKey) {
    t.pass('Skipping: No Cloud API key provided');
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

  const response = await client.withMetadata(metadata, async () => {
    return client.cloudService.getNamespace({ namespace });
  });
  t.is(response?.namespace?.namespace, namespace);
});
