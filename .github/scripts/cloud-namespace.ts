import { randomUUID } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { CloudOperationsClient, CloudOperationsConnection } from '../../packages/cloud';
import { temporal } from '../../packages/proto';
import { waitForNexusEndpointsReady } from '../../packages/test/lib/nexus-endpoint-readiness';
import { nexusEndpointTaskQueues, preCreatedNexusEndpointName } from '../../packages/test/lib/nexus-endpoints';
import { findCloudTestFiles } from '../../scripts/cloud-test-inventory';

const OPERATION_TIMEOUT_MS = 10 * 60 * 1_000;
const OperationState = temporal.api.cloud.operation.v1.AsyncOperation.State;
// Names of the namespaces and Nexus endpoints that CI runs create start with this.
const CI_RESOURCE_PREFIX = 'sdk-typescript-ci-';

type CloudNexusEndpoint = temporal.api.cloud.nexus.v1.IEndpoint;

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

function rejections(results: readonly PromiseSettledResult<void>[]): unknown[] {
  return results.filter((result) => result.status === 'rejected').map((result) => result.reason);
}

async function listNexusEndpoints(
  client: CloudOperationsClient,
  targetNamespaceId?: string
): Promise<CloudNexusEndpoint[]> {
  const endpoints: CloudNexusEndpoint[] = [];
  let pageToken = '';
  do {
    const page = await client.cloudService.getNexusEndpoints({ targetNamespaceId, pageToken, pageSize: 1000 });
    endpoints.push(...page.endpoints);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return endpoints;
}

async function listNamespaceIds(client: CloudOperationsClient): Promise<string[]> {
  const namespaces: string[] = [];
  let pageToken = '';
  do {
    const page = await client.cloudService.getNamespaces({ pageToken, pageSize: 1000 });
    namespaces.push(...page.namespaces.flatMap(({ namespace }) => (namespace ? [namespace] : [])));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return namespaces;
}

async function createNexusEndpoint(
  client: CloudOperationsClient,
  namespace: string,
  name: string,
  taskQueue: string
): Promise<void> {
  const result = await client.cloudService.createNexusEndpoint({
    asyncOperationId: randomUUID(),
    spec: {
      name,
      targetSpec: { workerTargetSpec: { namespaceId: namespace, taskQueue } },
      policySpecs: [{ allowedCloudNamespacePolicySpec: { namespaceId: namespace } }],
    },
  });
  if (!result.asyncOperation) throw new Error(`Create Nexus endpoint ${name} response did not include an operation`);
  await waitForOperation(client, result.asyncOperation);
}

async function deleteNexusEndpoint(client: CloudOperationsClient, endpoint: CloudNexusEndpoint): Promise<void> {
  const { id: endpointId, resourceVersion } = endpoint;
  if (!endpointId || !resourceVersion) {
    throw new Error(`Nexus endpoint ${endpoint.spec?.name} did not include an ID and resource version`);
  }
  const result = await client.cloudService.deleteNexusEndpoint({
    endpointId,
    resourceVersion,
    asyncOperationId: randomUUID(),
  });
  if (!result.asyncOperation)
    throw new Error(`Delete Nexus endpoint ${endpointId} response did not include an operation`);
  await waitForOperation(client, result.asyncOperation);
}

/**
 * Delete endpoints left behind by CI runs that died before cleanup, since they count against the account's endpoint
 * limit. Endpoints are listed before namespaces, so an endpoint whose namespace is missing cannot belong to a live run.
 */
async function deleteLeakedNexusEndpoints(client: CloudOperationsClient): Promise<void> {
  const endpoints = (await listNexusEndpoints(client)).filter(({ spec }) => spec?.name?.startsWith(CI_RESOURCE_PREFIX));
  const namespaces = new Set(await listNamespaceIds(client));
  const leaked = endpoints.filter(({ spec }) => !namespaces.has(spec?.targetSpec?.workerTargetSpec?.namespaceId ?? ''));
  const errors = rejections(await Promise.allSettled(leaked.map((endpoint) => deleteNexusEndpoint(client, endpoint))));
  // Best effort: another run may be deleting the same endpoints, and a later run will retry the rest.
  for (const error of errors) console.warn(`Could not delete a leaked Nexus endpoint: ${error}`);
  console.log(`Deleted ${leaked.length - errors.length} of ${leaked.length} leaked Nexus endpoints`);
}

async function create(): Promise<void> {
  await withCloudClient(async (client) => {
    const namespaceName = `${CI_RESOURCE_PREFIX}${requiredEnv('GITHUB_RUN_ID')}-${requiredEnv('GITHUB_RUN_ATTEMPT')}`;
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

/**
 * Create the Nexus endpoints that Cloud-eligible test files need (see `packages/test/src/nexus-endpoints.ts`), wait
 * until they are callable, and output the name prefix that tests use to find them.
 */
async function createNexusEndpoints(namespace: string): Promise<void> {
  // Endpoint names are unique per account, so start them with the run's namespace name.
  const prefix = namespace.split('.')[0];
  const endpoints = nexusEndpointTaskQueues(await findCloudTestFiles()).map((taskQueue) => ({
    name: preCreatedNexusEndpointName(prefix, taskQueue),
    taskQueue,
  }));

  await withCloudClient(async (client) => {
    await deleteLeakedNexusEndpoints(client);
    await Promise.all(endpoints.map(({ name, taskQueue }) => createNexusEndpoint(client, namespace, name, taskQueue)));
  });

  console.log(`Created ${endpoints.length} Nexus endpoints; waiting until they are callable`);
  if (endpoints.length > 0) {
    await waitForNexusEndpointsReady(
      {
        disableFile: true,
        overrideEnvVars: {
          TEMPORAL_ADDRESS: `${namespace}.tmprl.cloud:7233`,
          TEMPORAL_NAMESPACE: namespace,
          TEMPORAL_TLS_CLIENT_CERT_PATH: requiredEnv('TEMPORAL_TLS_CLIENT_CERT_PATH'),
          TEMPORAL_TLS_CLIENT_KEY_PATH: requiredEnv('TEMPORAL_TLS_CLIENT_KEY_PATH'),
        },
      },
      endpoints
    );
  }
  await appendFile(requiredEnv('GITHUB_OUTPUT'), `prefix=${prefix}\n`);
}

async function deleteNamespace(namespace: string): Promise<void> {
  await withCloudClient(async (client) => {
    // Endpoints are account resources that outlive the namespace they route to.
    const endpoints = await listNexusEndpoints(client, namespace);
    const endpointErrors = rejections(
      await Promise.allSettled(endpoints.map((endpoint) => deleteNexusEndpoint(client, endpoint)))
    );

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

    if (endpointErrors.length > 0) {
      throw new AggregateError(endpointErrors, `Failed to delete Nexus endpoints for ${namespace}`);
    }
  });
}

async function main(): Promise<void> {
  const [command, namespace] = process.argv.slice(2);
  if (command === 'create' && namespace === undefined) return await create();
  if (command === 'nexus-endpoints' && namespace !== undefined) return await createNexusEndpoints(namespace);
  if (command === 'delete' && namespace !== undefined) return await deleteNamespace(namespace);
  throw new Error('Usage: cloud-namespace.ts create | nexus-endpoints <namespace> | delete <namespace>');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
