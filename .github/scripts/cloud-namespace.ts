import { randomUUID } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { CloudOperationsClient, CloudOperationsConnection } from '../../packages/cloud';
import { temporal } from '../../packages/proto';

const OPERATION_TIMEOUT_MS = 10 * 60 * 1_000;
const OperationState = temporal.api.cloud.operation.v1.AsyncOperation.State;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function waitForOperation(
  client: CloudOperationsClient,
  initialOperation: temporal.api.cloud.operation.v1.IAsyncOperation
): Promise<void> {
  const operationId = initialOperation.id;
  if (!operationId) throw new Error('Cloud operation response did not include an ID');

  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  while (true) {
    const operation = (await client.cloudService.getAsyncOperation({ asyncOperationId: operationId })).asyncOperation;
    if (!operation) throw new Error(`Cloud operation ${operationId} could not be read`);

    if (operation.state === OperationState.STATE_FULFILLED) return;
    if (
      operation.state === OperationState.STATE_FAILED ||
      operation.state === OperationState.STATE_CANCELLED ||
      operation.state === OperationState.STATE_REJECTED
    ) {
      throw new Error(`Cloud operation ${operationId} failed: ${operation.failureReason}`);
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for Cloud operation ${operationId}`);

    const delayMs = Math.max(
      Number(operation.checkDuration?.seconds ?? 0) * 1_000 + (operation.checkDuration?.nanos ?? 0) / 1_000_000,
      1_000
    );
    await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, deadline - Date.now())));
  }
}

async function withCloudClient(fn: (client: CloudOperationsClient) => Promise<void>): Promise<void> {
  const apiVersion = requiredEnv('TEMPORAL_CLIENT_CLOUD_API_VERSION');
  const connection = await CloudOperationsConnection.connect({
    apiKey: requiredEnv('TEMPORAL_CLIENT_CLOUD_API_KEY'),
  });
  const client = new CloudOperationsClient({ connection, apiVersion });

  try {
    await client.withDeadline(Date.now() + OPERATION_TIMEOUT_MS, () =>
      client.withMetadata({ 'temporal-cloud-api-version': apiVersion }, () => fn(client))
    );
  } finally {
    connection.close();
  }
}

async function create(): Promise<void> {
  await withCloudClient(async (client) => {
    const namespaceName = `sdk-typescript-ci-${requiredEnv('GITHUB_RUN_ID')}-${requiredEnv('GITHUB_RUN_ATTEMPT')}`;
    const result = await client.cloudService.createNamespace({
      asyncOperationId: randomUUID(),
      spec: {
        name: namespaceName,
        regions: ['aws-ca-central-1'],
        retentionDays: 1,
        mtlsAuth: {
          acceptedClientCa: await readFile(requiredEnv('TEMPORAL_CLOUD_CLIENT_CA_PATH')),
          enabled: true,
        },
      },
    });
    // Make cleanup possible even if provisioning fails after Cloud accepts the request.
    if (!result.namespace) throw new Error('Create namespace response did not include a namespace');
    await appendFile(requiredEnv('GITHUB_OUTPUT'), `namespace=${result.namespace}\n`);
    if (!result.asyncOperation) throw new Error('Create namespace response did not include an operation');
    await waitForOperation(client, result.asyncOperation);
  });
}

async function deleteNamespace(namespace: string): Promise<void> {
  await withCloudClient(async (client) => {
    const existing = await client.cloudService.getNamespace({ namespace });
    const resourceVersion = existing.namespace?.resourceVersion;
    if (!resourceVersion) throw new Error(`Cloud namespace ${namespace} did not include a resource version`);

    const result = await client.cloudService.deleteNamespace({
      namespace,
      resourceVersion,
      asyncOperationId: randomUUID(),
    });
    if (!result.asyncOperation) throw new Error('Delete namespace response did not include an operation');
    await waitForOperation(client, result.asyncOperation);
  });
}

// TEMP(nexus-probe): checks whether the CI API key may manage Nexus endpoints. Not for merge.
async function probeNexusEndpoint(namespace: string): Promise<void> {
  await withCloudClient(async (client) => {
    const name = `sdk-typescript-ci-probe-${requiredEnv('GITHUB_RUN_ID')}-${requiredEnv('GITHUB_RUN_ATTEMPT')}`;
    let created: temporal.api.cloud.cloudservice.v1.CreateNexusEndpointResponse;
    try {
      created = await client.cloudService.createNexusEndpoint({
        asyncOperationId: randomUUID(),
        spec: {
          name,
          targetSpec: { workerTargetSpec: { namespaceId: namespace, taskQueue: 'nexus-probe' } },
          policySpecs: [{ allowedCloudNamespacePolicySpec: { namespaceId: namespace } }],
        },
      });
    } catch (error) {
      console.log(`NEXUS PROBE: createNexusEndpoint FAILED: ${(error as Error).message}`);
      throw error;
    }
    console.log(`NEXUS PROBE: createNexusEndpoint accepted (endpoint ${created.endpointId})`);
    if (!created.asyncOperation) throw new Error('Create endpoint response did not include an operation');
    await waitForOperation(client, created.asyncOperation);
    console.log('NEXUS PROBE: endpoint creation fulfilled');

    const existing = await client.cloudService.getNexusEndpoint({ endpointId: created.endpointId });
    const resourceVersion = existing.endpoint?.resourceVersion;
    if (!resourceVersion) throw new Error(`Nexus endpoint ${created.endpointId} did not include a resource version`);
    const deleted = await client.cloudService.deleteNexusEndpoint({
      endpointId: created.endpointId,
      resourceVersion,
      asyncOperationId: randomUUID(),
    });
    if (!deleted.asyncOperation) throw new Error('Delete endpoint response did not include an operation');
    await waitForOperation(client, deleted.asyncOperation);
    console.log('NEXUS PROBE: endpoint deleted');
  });
}

async function main(): Promise<void> {
  const [command, namespace] = process.argv.slice(2);
  if (command === 'create' && namespace === undefined) return await create();
  if (command === 'delete' && namespace !== undefined) return await deleteNamespace(namespace);
  if (command === 'nexus-probe' && namespace !== undefined) return await probeNexusEndpoint(namespace);
  throw new Error('Usage: cloud-namespace.ts create | delete <namespace> | nexus-probe <namespace>');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
