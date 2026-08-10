import test from 'ava';
import Long from 'long';
import { temporal } from '@temporalio/proto';
import {
  type CloudNamespaceService,
  cloudNamespaceName,
  cloudOperationId,
  createCloudNamespace,
  deleteCloudNamespace,
  waitForCloudOperation,
} from './cloud-namespace';

const OperationState = temporal.api.cloud.operation.v1.AsyncOperation.State;

function fakeService(overrides: Partial<CloudNamespaceService>): CloudNamespaceService {
  return overrides as CloudNamespaceService;
}

function protoResponse<T>(value: object): T {
  return value as T;
}

test('cloudNamespaceName derives a unique name from the GitHub run', (t) => {
  t.is(cloudNamespaceName('1234', '2'), 'sdk-typescript-ci-1234-2');
  t.throws(() => cloudNamespaceName('branch', '2'), { message: /positive integers/ });
});

test('cloudOperationId is a deterministic UUID for each mutation', (t) => {
  const createId = cloudOperationId('create', 'sdk-typescript-ci-1234-2');
  t.regex(createId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  t.is(createId, cloudOperationId('create', 'sdk-typescript-ci-1234-2'));
  t.not(createId, cloudOperationId('delete', 'sdk-typescript-ci-1234-2'));
});

test('createCloudNamespace registers cleanup before polling provisioning', async (t) => {
  const events: string[] = [];
  const service = fakeService({
    async createNamespace(request) {
      t.is(request.asyncOperationId, cloudOperationId('create', 'sdk-typescript-ci-1234-2'));
      t.deepEqual(request.spec?.regions, ['aws-ca-central-1']);
      t.is(request.spec?.retentionDays, 1);
      t.true(request.spec?.mtlsAuth?.enabled);
      events.push('create');
      return protoResponse<temporal.api.cloud.cloudservice.v1.CreateNamespaceResponse>({
        namespace: 'sdk-typescript-ci-1234-2.account',
        asyncOperation: { id: 'create-operation' },
      });
    },
    async getAsyncOperation() {
      events.push('poll');
      return protoResponse<temporal.api.cloud.cloudservice.v1.GetAsyncOperationResponse>({
        asyncOperation: { id: 'create-operation', state: OperationState.STATE_FULFILLED },
      });
    },
  });

  const namespace = await createCloudNamespace(service, {
    name: 'sdk-typescript-ci-1234-2',
    clientCa: Buffer.from('CA'),
    onAccepted: async () => {
      events.push('accepted');
    },
  });

  t.is(namespace, 'sdk-typescript-ci-1234-2.account');
  t.deepEqual(events, ['create', 'accepted', 'poll']);
});

test('waitForCloudOperation honors the server poll delay with a one-second minimum', async (t) => {
  const delays: number[] = [];
  let polls = 0;
  const service = fakeService({
    async getAsyncOperation() {
      polls++;
      return protoResponse<temporal.api.cloud.cloudservice.v1.GetAsyncOperationResponse>({
        asyncOperation: {
          id: 'operation',
          state: polls === 1 ? OperationState.STATE_IN_PROGRESS : OperationState.STATE_FULFILLED,
          checkDuration: { seconds: Long.ZERO, nanos: 100_000_000 },
        },
      });
    },
  });

  await waitForCloudOperation(
    service,
    { id: 'operation', checkDuration: { seconds: Long.fromInt(2) } },
    { sleep: async (delay) => void delays.push(delay) }
  );
  t.deepEqual(delays, [2_000, 1_000]);
});

test('createCloudNamespace registers cleanup before rejecting a missing operation', async (t) => {
  const accepted: string[] = [];
  const service = fakeService({
    async createNamespace() {
      return protoResponse<temporal.api.cloud.cloudservice.v1.CreateNamespaceResponse>({
        namespace: 'sdk-typescript-ci-1234-2.account',
      });
    },
  });

  await t.throwsAsync(
    createCloudNamespace(service, {
      name: 'sdk-typescript-ci-1234-2',
      clientCa: Buffer.from('CA'),
      onAccepted: async (namespace) => void accepted.push(namespace),
    }),
    { message: /did not include an operation/ }
  );
  t.deepEqual(accepted, ['sdk-typescript-ci-1234-2.account']);
});

test('waitForCloudOperation reports terminal failures', async (t) => {
  const service = fakeService({
    async getAsyncOperation() {
      return protoResponse<temporal.api.cloud.cloudservice.v1.GetAsyncOperationResponse>({
        asyncOperation: {
          id: 'operation',
          state: OperationState.STATE_REJECTED,
          failureReason: 'not authorized',
        },
      });
    },
  });

  await t.throwsAsync(waitForCloudOperation(service, { id: 'operation' }), {
    message: /state_rejected: not authorized/i,
  });
});

test('waitForCloudOperation times out', async (t) => {
  let now = 0;
  const service = fakeService({
    async getAsyncOperation() {
      return protoResponse<temporal.api.cloud.cloudservice.v1.GetAsyncOperationResponse>({
        asyncOperation: { id: 'operation', state: OperationState.STATE_IN_PROGRESS },
      });
    },
  });

  await t.throwsAsync(
    waitForCloudOperation(
      service,
      { id: 'operation' },
      {
        timeoutMs: 10,
        now: () => now,
        sleep: async (delay) => {
          now += delay;
        },
      }
    ),
    { message: 'Timed out waiting for Cloud operation operation' }
  );
});

test('deleteCloudNamespace uses the current resource version and waits', async (t) => {
  const service = fakeService({
    async getNamespace() {
      return protoResponse<temporal.api.cloud.cloudservice.v1.GetNamespaceResponse>({
        namespace: { namespace: 'test.account', resourceVersion: 'version-1' },
      });
    },
    async deleteNamespace(request) {
      t.is(request.namespace, 'test.account');
      t.is(request.resourceVersion, 'version-1');
      t.is(request.asyncOperationId, cloudOperationId('delete', 'test.account'));
      return protoResponse<temporal.api.cloud.cloudservice.v1.DeleteNamespaceResponse>({
        asyncOperation: { id: 'delete-operation' },
      });
    },
    async getAsyncOperation() {
      return protoResponse<temporal.api.cloud.cloudservice.v1.GetAsyncOperationResponse>({
        asyncOperation: { id: 'delete-operation', state: OperationState.STATE_FULFILLED },
      });
    },
  });

  await deleteCloudNamespace(service, 'test.account');
  t.pass();
});
