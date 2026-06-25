import assert from 'node:assert';
import { createHash } from 'node:crypto';
import test from 'ava';
import * as proto from '@temporalio/proto';
import { ValueError } from '@temporalio/common';
import type { Payload } from '@temporalio/common';
import { StorageDriverClaim, type StorageDriverStoreContext } from '@temporalio/common/lib/converter/extstore';
import { GcsStorageDriver } from '../driver';
import type { GcsStorageDriverClient } from '../client';

const PayloadProto = proto.temporal.api.common.v1.Payload;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function makePayload(value: string): Payload {
  return { metadata: { encoding: enc('json/plain') }, data: enc(value) };
}

function payloadBytes(p: Payload): Uint8Array {
  return PayloadProto.encode(p).finish();
}

class FakeGcsClient implements GcsStorageDriverClient {
  readonly objects = new Map<string, Uint8Array>();
  saveCount = 0;
  describeValue: Record<string, string> = {};

  async save(bucket: string, object: string, data: Uint8Array): Promise<void> {
    this.saveCount += 1;
    const k = `${bucket}/${object}`;
    if (!this.objects.has(k)) this.objects.set(k, data);
  }

  async download(bucket: string, object: string): Promise<Uint8Array> {
    const value = this.objects.get(`${bucket}/${object}`);
    if (!value) throw new Error(`missing object ${bucket}/${object}`);
    return value;
  }

  describe(): Record<string, string> {
    return this.describeValue;
  }
}

const workflowContext: StorageDriverStoreContext = {
  target: { kind: 'workflow', namespace: 'my-ns', type: 'MyWorkflow', id: 'wf-1', runId: 'run-1' },
};

test('store then retrieve round-trips the payload bytes', async (t) => {
  const driver = new GcsStorageDriver({ client: new FakeGcsClient(), bucket: 'b' });
  const original = makePayload('"hello"');

  const [claim] = await driver.store(workflowContext, [original]);
  assert(claim);
  const [retrieved] = await driver.retrieve({}, [claim]);
  assert(retrieved);

  t.deepEqual(payloadBytes(retrieved), payloadBytes(original));
});

test('object name is content-addressed and segmented by the store context', async (t) => {
  const driver = new GcsStorageDriver({ client: new FakeGcsClient(), bucket: 'b' });
  const payload = makePayload('"hello"');
  const expectedHash = createHash('sha256').update(payloadBytes(payload)).digest('hex');

  const [claim] = await driver.store(workflowContext, [payload]);
  assert(claim);

  t.is(claim.claimData.object, `v0/ns/my-ns/wt/MyWorkflow/wi/wf-1/ri/run-1/d/sha256/${expectedHash}`);
  t.is(claim.claimData.hashValue, expectedHash);
  t.is(claim.claimData.hashAlgorithm, 'sha256');
  t.is(claim.claimData.bucket, 'b');
});

test('object name segments percent-encode only GCS-discouraged characters', async (t) => {
  const driver = new GcsStorageDriver({ client: new FakeGcsClient(), bucket: 'b' });

  const [claim] = await driver.store(
    {
      target: {
        kind: 'workflow',
        namespace: 'payments prod',
        type: "Capture/Charge!*'()",
        id: 'order+123=abc',
        runId: 'r~1',
      },
    },
    [makePayload('"x"')]
  );
  assert(claim?.claimData.object);

  // Per Google's recommendations: space, + = ~ ! ' ( ) are left intact;
  // / -> %2F and * -> %2A are escaped.
  t.true(
    claim.claimData.object.startsWith(
      "v0/ns/payments prod/wt/Capture%2FCharge!%2A'()/wi/order+123=abc/ri/r~1/d/sha256/"
    )
  );
});

test('reserved and empty segments are encoded', async (t) => {
  const driver = new GcsStorageDriver({ client: new FakeGcsClient(), bucket: 'b' });

  // namespace '.' and type '..' are reserved object names; id is absent and runId is
  // empty. Reserved names escape to %2E / %2E%2E; empty or absent values become 'null'.
  const [claim] = await driver.store({ target: { kind: 'workflow', namespace: '.', type: '..', runId: '' } }, [
    makePayload('"x"'),
  ]);
  assert(claim?.claimData.object);

  t.true(claim.claimData.object.startsWith('v0/ns/%2E/wt/%2E%2E/wi/null/ri/null/d/sha256/'));
});

test('a target with no identity falls back to a bare digest object name', async (t) => {
  const driver = new GcsStorageDriver({ client: new FakeGcsClient(), bucket: 'b' });

  const [claim] = await driver.store({}, [makePayload('"x"')]);
  assert(claim?.claimData.object);

  t.regex(claim.claimData.object, /^v0\/d\/sha256\/[0-9a-f]{64}$/);
});

test('identical payloads in the same scope deduplicate to one stored object', async (t) => {
  const client = new FakeGcsClient();
  const driver = new GcsStorageDriver({ client, bucket: 'b' });

  const [first] = await driver.store(workflowContext, [makePayload('"hello"')]);
  const [second] = await driver.store(workflowContext, [makePayload('"hello"')]);
  assert(first);
  assert(second);

  t.is(client.objects.size, 1);
  t.deepEqual(first.claimData, second.claimData);
});

test('concurrent identical payloads in one batch upload once', async (t) => {
  const client = new FakeGcsClient();
  const driver = new GcsStorageDriver({ client, bucket: 'b' });

  const [first, second] = await driver.store(workflowContext, [makePayload('"hello"'), makePayload('"hello"')]);
  assert(first);
  assert(second);

  t.is(client.saveCount, 1);
  t.is(first.claimData.object, second.claimData.object);
});

test('retrieve rejects when stored bytes fail the integrity check', async (t) => {
  const client = new FakeGcsClient();
  const driver = new GcsStorageDriver({ client, bucket: 'b' });

  const [claim] = await driver.store(workflowContext, [makePayload('"hello"')]);
  assert(claim);
  client.objects.set(`${claim.claimData.bucket}/${claim.claimData.object}`, enc('tampered'));

  await t.throwsAsync(() => driver.retrieve({}, [claim]), {
    instanceOf: ValueError,
    message: /integrity check failed/,
  });
});

test('store rejects payloads larger than maxPayloadSize', async (t) => {
  const driver = new GcsStorageDriver({ client: new FakeGcsClient(), bucket: 'b', maxPayloadSize: 1 });

  await t.throwsAsync(() => driver.store(workflowContext, [makePayload('"hello"')]), {
    instanceOf: ValueError,
    message: /exceeds the configured maxPayloadSize/,
  });
});

test('retrieve rejects a claim missing hash information', async (t) => {
  const client = new FakeGcsClient();
  const driver = new GcsStorageDriver({ client, bucket: 'b' });
  client.objects.set('b/some-object', payloadBytes(makePayload('"hello"')));

  const claim = new StorageDriverClaim({ bucket: 'b', object: 'some-object' });

  await t.throwsAsync(() => driver.retrieve({}, [claim]), {
    instanceOf: ValueError,
    message: /missing required content hash information/,
  });
});

test('bucket selector chooses the destination per payload', async (t) => {
  const client = new FakeGcsClient();
  const driver = new GcsStorageDriver({
    client,
    bucket: (_ctx, payload) => ((payload.data?.length ?? 0) > 4 ? 'large' : 'small'),
  });

  const [big] = await driver.store(workflowContext, [makePayload('"a-long-value"')]);
  const [small] = await driver.store(workflowContext, [makePayload('"x"')]);
  assert(big);
  assert(small);

  t.is(big.claimData.bucket, 'large');
  t.is(small.claimData.bucket, 'small');
});

test('store waits for in-flight siblings to settle before surfacing a failure', async (t) => {
  let siblingSettled = false;
  const client: GcsStorageDriverClient = {
    async save(bucket: string) {
      if (bucket === 'fail') {
        throw new Error('boom');
      }
      // setImmediate is deliberately a macrotask. The failing sibling rejects on a
      // microtask, and the assertion below runs in that same microtask phase; this
      // macrotask therefore resolves only after it. So if store() ever fails fast
      // (e.g. Promise.all instead of allSettled), the assertion would observe
      // siblingSettled === false and fail. Awaiting every task (allSettled) is what
      // lets this complete first. Do not weaken to a microtask.
      await new Promise<void>((resolve) => setImmediate(resolve));
      siblingSettled = true;
    },
    async download(): Promise<Uint8Array> {
      throw new Error('unused');
    },
  };
  const driver = new GcsStorageDriver({
    client,
    bucket: (_ctx, payload) => ((payload.data?.length ?? 0) < 5 ? 'fail' : 'ok'),
  });

  await t.throwsAsync(
    () => driver.store(workflowContext, [makePayload('"x"'), makePayload('"a-much-longer-sibling-value"')]),
    { message: /store failed/ }
  );
  t.true(siblingSettled);
});
