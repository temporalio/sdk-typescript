import assert from 'node:assert';
import { createHash } from 'node:crypto';
import test from 'ava';
import * as proto from '@temporalio/proto';
import { ValueError } from '@temporalio/common';
import type { Payload } from '@temporalio/common';
import { StorageDriverClaim, type StorageDriverStoreContext } from '@temporalio/common/lib/converter/extstore';
import { S3StorageDriver } from '../driver';
import type { S3StorageDriverClient, S3RequestOptions } from '../client';

const PayloadProto = proto.temporal.api.common.v1.Payload;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function makePayload(value: string): Payload {
  return { metadata: { encoding: enc('json/plain') }, data: enc(value) };
}

function payloadBytes(p: Payload): Uint8Array {
  return PayloadProto.encode(p).finish();
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

class FakeS3Client implements S3StorageDriverClient {
  readonly objects = new Map<string, Uint8Array>();
  putCount = 0;
  describeValue: Record<string, string> = {};

  async putObject(bucket: string, key: string, data: Uint8Array): Promise<void> {
    this.putCount += 1;
    this.objects.set(`${bucket}/${key}`, data);
  }

  async objectExists(bucket: string, key: string): Promise<boolean> {
    return this.objects.has(`${bucket}/${key}`);
  }

  async getObject(bucket: string, key: string): Promise<Uint8Array> {
    const value = this.objects.get(`${bucket}/${key}`);
    if (!value) throw new Error(`missing object ${bucket}/${key}`);
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
  const driver = new S3StorageDriver({ client: new FakeS3Client(), bucket: 'b' });
  const original = makePayload('"hello"');

  const [claim] = await driver.store(workflowContext, [original]);
  assert(claim);
  const [retrieved] = await driver.retrieve({}, [claim]);
  assert(retrieved);

  t.deepEqual(payloadBytes(retrieved), payloadBytes(original));
});

test('key is content-addressed and segmented by the store context', async (t) => {
  const driver = new S3StorageDriver({ client: new FakeS3Client(), bucket: 'b' });
  const payload = makePayload('"hello"');

  const [claim] = await driver.store(workflowContext, [payload]);
  assert(claim?.claimData.key);

  const digest = sha256Hex(payloadBytes(payload));
  t.is(claim.claimData.key, `v0/ns/my-ns/wt/MyWorkflow/wi/wf-1/ri/run-1/d/sha256/${digest}`);
  t.is(claim.claimData.hashValue, digest);
  t.is(claim.claimData.hashAlgorithm, 'sha256');
  t.is(claim.claimData.bucket, 'b');

  const [other] = await driver.store(workflowContext, [makePayload('"world"')]);
  assert(other?.claimData.key);
  t.not(other.claimData.key, claim.claimData.key);
  t.is(other.claimData.key.replace(/[0-9a-f]{64}$/, ''), claim.claimData.key.replace(/[0-9a-f]{64}$/, ''));
});

test('key segments percent-encode anything outside the S3 safe set', async (t) => {
  const driver = new S3StorageDriver({ client: new FakeS3Client(), bucket: 'b' });

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
  assert(claim?.claimData.key);

  // space -> %20, / -> %2F, !*'() kept, + -> %2B, = -> %3D, ~ -> %7E
  t.true(
    claim.claimData.key.startsWith(
      "v0/ns/payments%20prod/wt/Capture%2FCharge!*'()/wi/order%2B123%3Dabc/ri/r%7E1/d/sha256/"
    )
  );
});

test('a target with no identity falls back to a bare digest key', async (t) => {
  const driver = new S3StorageDriver({ client: new FakeS3Client(), bucket: 'b' });

  const [claim] = await driver.store({}, [makePayload('"x"')]);
  assert(claim?.claimData.key);

  t.regex(claim.claimData.key, /^v0\/d\/sha256\/[0-9a-f]{64}$/);
});

test('missing context segments are encoded as the literal "null"', async (t) => {
  const driver = new S3StorageDriver({ client: new FakeS3Client(), bucket: 'b' });

  const [claim] = await driver.store({ target: { kind: 'workflow', namespace: 'my-ns' } }, [makePayload('"x"')]);
  assert(claim?.claimData.key);

  t.true(claim.claimData.key.startsWith('v0/ns/my-ns/wt/null/wi/null/ri/null/d/sha256/'));
});

test('identical payloads in the same scope deduplicate to one upload', async (t) => {
  const client = new FakeS3Client();
  const driver = new S3StorageDriver({ client, bucket: 'b' });

  await driver.store(workflowContext, [makePayload('"hello"')]);
  await driver.store(workflowContext, [makePayload('"hello"')]);

  t.is(client.putCount, 1);
});

test('retrieve rejects when stored bytes fail the integrity check', async (t) => {
  const client = new FakeS3Client();
  const driver = new S3StorageDriver({ client, bucket: 'b' });

  const [claim] = await driver.store(workflowContext, [makePayload('"hello"')]);
  assert(claim);
  client.objects.set(`${claim.claimData.bucket}/${claim.claimData.key}`, enc('tampered'));

  await t.throwsAsync(() => driver.retrieve({}, [claim]), {
    instanceOf: ValueError,
    message: /integrity check failed/,
  });
});

test('store rejects payloads larger than maxPayloadSize', async (t) => {
  const driver = new S3StorageDriver({ client: new FakeS3Client(), bucket: 'b', maxPayloadSize: 1 });

  await t.throwsAsync(() => driver.store(workflowContext, [makePayload('"hello"')]), {
    instanceOf: ValueError,
    message: /exceeds the configured maxPayloadSize/,
  });
});

test('retrieve rejects a claim missing hash information', async (t) => {
  const client = new FakeS3Client();
  const driver = new S3StorageDriver({ client, bucket: 'b' });
  client.objects.set('b/some-key', payloadBytes(makePayload('"hello"')));

  const claim = new StorageDriverClaim({ bucket: 'b', key: 'some-key' });

  await t.throwsAsync(() => driver.retrieve({}, [claim]), {
    instanceOf: ValueError,
    message: /missing required content hash information/,
  });
});

test('bucket selector chooses the destination per payload', async (t) => {
  const client = new FakeS3Client();
  const driver = new S3StorageDriver({
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

test('store aborts in-flight sibling uploads when one fails', async (t) => {
  let siblingAborted = false;
  const client: S3StorageDriverClient = {
    async objectExists() {
      return false;
    },
    async putObject(bucket: string, _key: string, _data: Uint8Array, options?: S3RequestOptions): Promise<void> {
      if (bucket === 'fail') {
        throw new Error('boom');
      }
      await new Promise<void>((resolve) => {
        options?.abortSignal?.addEventListener('abort', () => {
          siblingAborted = true;
          resolve();
        });
      });
    },
    async getObject(): Promise<Uint8Array> {
      throw new Error('unused');
    },
  };
  const driver = new S3StorageDriver({
    client,
    bucket: (_ctx, payload) => ((payload.data?.length ?? 0) < 5 ? 'fail' : 'ok'),
  });

  await t.throwsAsync(
    () => driver.store(workflowContext, [makePayload('"x"'), makePayload('"a-much-longer-sibling-value"')]),
    { message: /store failed/ }
  );
  t.true(siblingAborted);
});
