import { createHash } from 'node:crypto';
import { temporal } from '@temporalio/proto';

const DEFAULT_OPERATION_TIMEOUT_MS = 10 * 60 * 1_000;
const MINIMUM_POLL_DELAY_MS = 1_000;

const OperationState = temporal.api.cloud.operation.v1.AsyncOperation.State;

export type CloudNamespaceService = Pick<
  temporal.api.cloud.cloudservice.v1.CloudService,
  'createNamespace' | 'deleteNamespace' | 'getAsyncOperation' | 'getNamespace'
>;

export interface WaitForCloudOperationOptions {
  timeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface CreateCloudNamespaceOptions extends WaitForCloudOperationOptions {
  name: string;
  clientCa: Uint8Array;
  onAccepted?: (namespace: string) => Promise<void>;
}

function operationStateName(state: temporal.api.cloud.operation.v1.AsyncOperation.State | null | undefined): string {
  return OperationState[state ?? OperationState.STATE_UNSPECIFIED] ?? `STATE_${state}`;
}

function pollDelayMilliseconds(operation: temporal.api.cloud.operation.v1.IAsyncOperation): number {
  const seconds = Number(operation.checkDuration?.seconds ?? 0);
  const nanos = operation.checkDuration?.nanos ?? 0;
  return Math.max(seconds * 1_000 + nanos / 1_000_000, MINIMUM_POLL_DELAY_MS);
}

export function cloudNamespaceName(runId: string, runAttempt: string): string {
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(runAttempt)) {
    throw new TypeError('GitHub run ID and attempt must be positive integers');
  }
  return `sdk-typescript-ci-${runId}-${runAttempt}`;
}

export function cloudOperationId(action: 'create' | 'delete', namespace: string): string {
  const bytes = createHash('sha256').update(`${action}:${namespace}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function waitForCloudOperation(
  service: CloudNamespaceService,
  initialOperation: temporal.api.cloud.operation.v1.IAsyncOperation,
  options: WaitForCloudOperationOptions = {}
): Promise<void> {
  const operationId = initialOperation.id;
  if (!operationId) {
    throw new Error('Cloud operation response did not include an operation ID');
  }

  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + (options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);

  let operation = initialOperation;
  while (true) {
    switch (operation.state) {
      case OperationState.STATE_FULFILLED:
        return;
      case OperationState.STATE_FAILED:
      case OperationState.STATE_CANCELLED:
      case OperationState.STATE_REJECTED:
        throw new Error(
          `Cloud operation ${operationId} ${operationStateName(operation.state).toLowerCase()}: ${
            operation.failureReason || 'no failure reason provided'
          }`
        );
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for Cloud operation ${operationId}`);
    }
    await sleep(Math.min(pollDelayMilliseconds(operation), remaining));

    const response = await service.getAsyncOperation({ asyncOperationId: operationId });
    if (!response.asyncOperation) {
      throw new Error(`Cloud operation ${operationId} could not be read`);
    }
    operation = response.asyncOperation;
  }
}

export async function createCloudNamespace(
  service: CloudNamespaceService,
  options: CreateCloudNamespaceOptions
): Promise<string> {
  const response = await service.createNamespace({
    asyncOperationId: cloudOperationId('create', options.name),
    spec: {
      name: options.name,
      regions: ['aws-ca-central-1'],
      retentionDays: 1,
      mtlsAuth: {
        acceptedClientCa: options.clientCa,
        enabled: true,
      },
    },
  });
  const namespace = response.namespace;
  if (!namespace) {
    throw new Error('Create namespace response did not include a namespace');
  }

  // Register cleanup as soon as Cloud accepts the namespace, before waiting for provisioning.
  await options.onAccepted?.(namespace);
  const operation = response.asyncOperation;
  if (!operation) {
    throw new Error('Create namespace response did not include an operation');
  }
  await waitForCloudOperation(service, operation, options);
  return namespace;
}

export async function deleteCloudNamespace(
  service: CloudNamespaceService,
  namespace: string,
  options: WaitForCloudOperationOptions = {}
): Promise<void> {
  const existing = await service.getNamespace({ namespace });
  const resourceVersion = existing.namespace?.resourceVersion;
  if (!resourceVersion) {
    throw new Error(`Cloud namespace ${namespace} did not include a resource version`);
  }

  const response = await service.deleteNamespace({
    namespace,
    resourceVersion,
    asyncOperationId: cloudOperationId('delete', namespace),
  });
  if (!response.asyncOperation) {
    throw new Error(`Delete namespace response for ${namespace} did not include an operation`);
  }
  await waitForCloudOperation(service, response.asyncOperation, options);
}
