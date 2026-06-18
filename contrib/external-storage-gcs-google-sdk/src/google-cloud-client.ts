import type { Storage } from '@google-cloud/storage';
import type { GcsStorageDriverClient, GcsRequestOptions } from '@temporalio/external-storage-gcs';

/**
 * A {@link GcsStorageDriverClient} backed by a `@google-cloud/storage` `Storage`
 * instance, for use with `GcsStorageDriver`.
 *
 * `@google-cloud/storage` cannot cancel a request once it is in flight, so an
 * `abortSignal` is checked up front.
 *
 * @experimental
 */
export class GoogleCloudGcsStorageDriverClient implements GcsStorageDriverClient {
  constructor(private readonly storage: Storage) {}

  describe(): Record<string, string> {
    const projectId = this.storage.projectId;
    return typeof projectId === 'string' && projectId ? { projectId } : {};
  }

  async save(bucket: string, object: string, data: Uint8Array, options?: GcsRequestOptions): Promise<void> {
    options?.abortSignal?.throwIfAborted();
    const file = this.storage.bucket(bucket).file(object);
    try {
      // ifGenerationMatch: 0 is GCS's atomic create-if-absent
      await file.save(data, { preconditionOpts: { ifGenerationMatch: 0 } });
    } catch (err) {
      // That 412 means the object already exists, which for content-addressed
      // payloads is a successful no-op.
      if (isAlreadyExistsError(err)) return;
      throw err;
    }
  }

  async download(bucket: string, object: string, options?: GcsRequestOptions): Promise<Uint8Array> {
    options?.abortSignal?.throwIfAborted();
    const file = this.storage.bucket(bucket).file(object);
    const [contents] = await file.download();
    return contents;
  }
}

/** A create-if-absent upload fails with HTTP 412 when the object already exists. */
function isAlreadyExistsError(err: unknown): boolean {
  return (err as { code?: number })?.code === 412;
}
