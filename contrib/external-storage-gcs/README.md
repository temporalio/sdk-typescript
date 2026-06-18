# Google Cloud Storage External Storage Driver for Temporal

> ⚠️ **This package is experimental and may be subject to change.** ⚠️

`@temporalio/external-storage-gcs` provides a Google Cloud Storage-backed `StorageDriver` for the Temporal TypeScript SDK's External Storage system. Large payloads are offloaded to a GCS bucket and replaced with a storage reference in the Temporal history event. The reference is resolved back to the original payload before it reaches application code.

This package defines the driver and the `GcsStorageDriverClient` interface it depends on, with **no Google Cloud SDK dependency**. Use the companion package [`@temporalio/external-storage-gcs-google-sdk`](../external-storage-gcs-google-sdk) to back it with a [`@google-cloud/storage`](https://www.npmjs.com/package/@google-cloud/storage) `Storage` client, or implement `GcsStorageDriverClient` yourself.

## Usage

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

- Payloads are **content-addressed** by the SHA-256 hash of their serialized bytes.
- Object names follow [Google's object naming recommendations](https://cloud.google.com/storage/docs/objects#naming) and are segmented by namespace and workflow/activity identity, e.g. `v0/ns/<namespace>/wt/<workflowType>/wi/<workflowId>/ri/<runId>/d/sha256/<hash>`.
