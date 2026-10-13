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

type AuthMethod = 'mtls' | 'api-key';

async function create(authMethod: AuthMethod): Promise<void> {
  await withCloudClient(async (client) => {
    // Cloud namespace names are limited to 39 characters.
    const suffix = authMethod === 'api-key' ? '-apikey' : '';
    const namespaceName = `sdk-typescript-ci-${requiredEnv('GITHUB_RUN_ID')}-${requiredEnv(
      'GITHUB_RUN_ATTEMPT'
    )}${suffix}`;
    const result = await client.cloudService.createNamespace({
      asyncOperationId: randomUUID(),
      spec: {
        name: namespaceName,
        regions: ['aws-ca-central-1'],
        retentionDays: 1,
        // Cloud fixes a namespace's auth method at creation, so each auth method needs its own namespace.
        ...(authMethod === 'mtls'
          ? {
              mtlsAuth: {
                acceptedClientCa: await readFile(requiredEnv('TEMPORAL_CLOUD_CLIENT_CA_PATH')),
                enabled: true,
              },
            }
          : { apiKeyAuth: { enabled: true } }),
      },
    });
    // Make cleanup possible even if provisioning fails after Cloud accepts the request.
    if (!result.namespace) throw new Error('Create namespace response did not include a namespace');
    await appendFile(requiredEnv('GITHUB_OUTPUT'), `namespace=${result.namespace}\n`);
    if (!result.asyncOperation) throw new Error('Create namespace response did not include an operation');
    await waitForOperation(client, result.asyncOperation);

    // Publish the gRPC address Cloud assigned for this auth method, rather than deriving it from the region.
    const { endpoints } = (await client.cloudService.getNamespace({ namespace: result.namespace })).namespace ?? {};
    const address = authMethod === 'mtls' ? endpoints?.mtlsGrpcAddress : endpoints?.grpcAddress;
    if (!address) throw new Error(`Cloud namespace ${result.namespace} did not report a ${authMethod} gRPC address`);
    console.log(`Namespace ${result.namespace} ${authMethod} gRPC address: ${address}`);
    await appendFile(requiredEnv('GITHUB_OUTPUT'), `address=${address}\n`);
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

async function main(): Promise<void> {
  const [command, namespace] = process.argv.slice(2);
  if (command === 'create' && (namespace === undefined || namespace === 'mtls')) return await create('mtls');
  if (command === 'create' && namespace === 'api-key') return await create('api-key');
  if (command === 'delete' && namespace !== undefined) return await deleteNamespace(namespace);
  throw new Error('Usage: cloud-namespace.ts create [mtls|api-key] | delete <namespace>');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
