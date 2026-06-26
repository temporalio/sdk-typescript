import test from 'ava';
import type { Storage } from '@google-cloud/storage';
import { GoogleCloudGcsStorageDriverClient } from '../google-cloud-client';

interface FakeFile {
  save?: (data: Uint8Array, options?: unknown) => Promise<void>;
  download?: () => Promise<[Buffer]>;
}

/** Minimal Storage stand-in: only `bucket().file()`, `save`/`download`, and `projectId` are exercised. */
function fakeStorage(file: FakeFile, projectId?: string): Storage {
  return { projectId, bucket: () => ({ file: () => file }) } as unknown as Storage;
}

test('save uploads with an ifGenerationMatch: 0 precondition', async (t) => {
  let received: unknown;
  const client = new GoogleCloudGcsStorageDriverClient(
    fakeStorage({
      save: async (_data, options) => {
        received = options;
      },
    })
  );

  await client.save('b', 'o', new Uint8Array([1, 2, 3]));

  t.deepEqual(received, { preconditionOpts: { ifGenerationMatch: 0 } });
});

test('save treats a 412 precondition failure as a successful no-op', async (t) => {
  const client = new GoogleCloudGcsStorageDriverClient(
    fakeStorage({
      save: async () => {
        throw Object.assign(new Error('precondition failed'), { code: 412 });
      },
    })
  );

  await t.notThrowsAsync(() => client.save('b', 'o', new Uint8Array([1])));
});

test('save rethrows non-412 errors', async (t) => {
  const client = new GoogleCloudGcsStorageDriverClient(
    fakeStorage({
      save: async () => {
        throw Object.assign(new Error('denied'), { code: 403 });
      },
    })
  );

  await t.throwsAsync(() => client.save('b', 'o', new Uint8Array([1])), { message: 'denied' });
});

test('download resolves the stored bytes', async (t) => {
  const bytes = Buffer.from([1, 2, 3]);
  const client = new GoogleCloudGcsStorageDriverClient(fakeStorage({ download: async () => [bytes] }));

  t.deepEqual(await client.download('b', 'o'), bytes);
});

test('an already-aborted signal short-circuits before issuing the request', async (t) => {
  let saveCalled = false;
  const client = new GoogleCloudGcsStorageDriverClient(
    fakeStorage({
      save: async () => {
        saveCalled = true;
      },
    })
  );

  await t.throwsAsync(() => client.save('b', 'o', new Uint8Array([1]), { abortSignal: AbortSignal.abort() }), {
    name: 'AbortError',
  });
  t.false(saveCalled);
});

test('describe surfaces the project ID when available', (t) => {
  const client = new GoogleCloudGcsStorageDriverClient(fakeStorage({}, 'my-project'));
  t.deepEqual(client.describe(), { projectId: 'my-project' });
});

test('describe omits the project ID when unavailable', (t) => {
  const client = new GoogleCloudGcsStorageDriverClient(fakeStorage({}));
  t.deepEqual(client.describe(), {});
});
