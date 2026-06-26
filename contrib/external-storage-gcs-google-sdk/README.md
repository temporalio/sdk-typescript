# @google-cloud/storage Client for the Temporal GCS External Storage Driver

> ⚠️ **This package is experimental and may be subject to change.** ⚠️

`@temporalio/external-storage-gcs-google-sdk` provides a [`@google-cloud/storage`](https://www.npmjs.com/package/@google-cloud/storage)-backed `GcsStorageDriverClient` for [`@temporalio/external-storage-gcs`](../external-storage-gcs).

`@google-cloud/storage` is a peer dependency, so the driver uses the same `Storage` instance (and version) your application already configures.

## Usage

    npm install @temporalio/external-storage-gcs @temporalio/external-storage-gcs-google-sdk @google-cloud/storage

```ts
import { Storage } from '@google-cloud/storage';
import { GcsStorageDriver } from '@temporalio/external-storage-gcs';
import { GoogleCloudGcsStorageDriverClient } from '@temporalio/external-storage-gcs-google-sdk';

const storage = new Storage();
const driver = new GcsStorageDriver({
  client: new GoogleCloudGcsStorageDriverClient(storage),
  bucket: 'my-temporal-payloads',
});
```

## Notes

- Uploads use an atomic create-if-absent precondition (`ifGenerationMatch: 0`); a `412 Precondition Failed` from an already-stored object is treated as a successful no-op.
- `@google-cloud/storage` cannot cancel a request once it is in flight, so an `abortSignal` is honored only up front (via `AbortSignal.throwIfAborted()`): a signal that has already fired prevents the request from starting. An in-flight request is always awaited, so no request is left running in the background.
