import test from 'ava';
import type { S3Client } from '@aws-sdk/client-s3';
import { AwsSdkS3StorageDriverClient } from '../aws-sdk-client';

/** Minimal S3Client stand-in: only `send` and `config.region` are exercised. */
function fakeS3Client(send: (command: unknown) => Promise<unknown>, region?: string): S3Client {
  return { send, config: { region } } as unknown as S3Client;
}

test('objectExists maps a NotFound error to false', async (t) => {
  const client = new AwsSdkS3StorageDriverClient(
    fakeS3Client(() => Promise.reject(Object.assign(new Error('not found'), { name: 'NotFound' })))
  );
  t.false(await client.objectExists('b', 'k'));
});

test('objectExists maps a 404 status to false', async (t) => {
  const client = new AwsSdkS3StorageDriverClient(
    fakeS3Client(() => Promise.reject(Object.assign(new Error('nope'), { $metadata: { httpStatusCode: 404 } })))
  );
  t.false(await client.objectExists('b', 'k'));
});

test('objectExists rethrows non-404 errors', async (t) => {
  const client = new AwsSdkS3StorageDriverClient(
    fakeS3Client(() => Promise.reject(Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } })))
  );
  await t.throwsAsync(() => client.objectExists('b', 'k'), { message: 'denied' });
});

test('objectExists returns true when the head succeeds', async (t) => {
  const client = new AwsSdkS3StorageDriverClient(fakeS3Client(() => Promise.resolve({})));
  t.true(await client.objectExists('b', 'k'));
});

test('getObject reads the response body as bytes', async (t) => {
  const bytes = new Uint8Array([1, 2, 3]);
  const client = new AwsSdkS3StorageDriverClient(
    fakeS3Client(() => Promise.resolve({ Body: { transformToByteArray: async () => bytes } }))
  );
  t.deepEqual(await client.getObject('b', 'k'), bytes);
});

test('getObject throws when the response has no body', async (t) => {
  const client = new AwsSdkS3StorageDriverClient(fakeS3Client(() => Promise.resolve({})));
  await t.throwsAsync(() => client.getObject('b', 'k'), { message: /empty body/ });
});

test('describe surfaces a plain-string region', (t) => {
  const client = new AwsSdkS3StorageDriverClient(fakeS3Client(() => Promise.resolve({}), 'us-west-2'));
  t.deepEqual(client.describe?.(), { clientRegion: 'us-west-2' });
});

test('describe omits region when unavailable', (t) => {
  const client = new AwsSdkS3StorageDriverClient(fakeS3Client(() => Promise.resolve({})));
  t.deepEqual(client.describe?.(), {});
});
