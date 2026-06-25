# Google Cloud Storage External Storage Driver for the Temporal TypeScript SDK

> ⚠️ **This package is experimental and may be subject to change.** ⚠️

`@temporalio/external-storage-gcs` stores and retrieves Temporal payloads in Google Cloud Storage via the [External Storage](https://docs.temporal.io/external-storage) feature.

This package has no Google Cloud dependency: it defines the driver and the `GcsStorageDriverClient` interface, and you supply the GCS client. Use the companion [`@temporalio/external-storage-gcs-google-sdk`](../external-storage-gcs-google-sdk) package for a [`@google-cloud/storage`](https://www.npmjs.com/package/@google-cloud/storage) `Storage`-backed client, or implement the interface yourself.

## Using the Google Cloud SDK client

Install the adapter package alongside this one:

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

Register the resulting driver with the SDK's External Storage configuration so the
client and worker offload eligible payloads to it.

## Custom GCS client implementations

To use a different GCS library, implement `GcsStorageDriverClient`.

```ts
import type { GcsStorageDriverClient } from '@temporalio/external-storage-gcs';

const myClient: GcsStorageDriverClient = {
  async save(bucket, object, data, options) {
    /* ... */
  },
  async download(bucket, object, options) {
    /* ... */
    return new Uint8Array();
  },
};
```

## Dynamic bucket selection

Pass a callable as `bucket` to choose the destination per payload:

```ts
const driver = new GcsStorageDriver({
  client: new GoogleCloudGcsStorageDriverClient(storage),
  bucket: (_context, payload) => ((payload.data?.length ?? 0) > 10 * 1024 * 1024 ? 'large-payloads' : 'small-payloads'),
});
```

## Required IAM permissions

The credentials used by your GCS client must have these permissions on the target bucket and its objects:

- `storage.objects.create` — required by components that store payloads (typically the client and worker sending workflow/activity inputs). Granted by the `roles/storage.objectCreator` role.
- `storage.objects.get` — required by components that retrieve payloads. Granted by the `roles/storage.objectViewer` role.

Components that only retrieve do not need `storage.objects.create`, and vice versa.

## GCS Object Name Specification

All Temporal GCS drivers generate object names in a consistent manner.

### Object name format

Workflow object name:

```text
v0/ns/{namespace}/wt/{workflow-type}/wi/{workflow-id}/ri/{run-id}/d/{hash-algorithm}/{hex-digest}
```

Activity object name:

```text
v0/ns/{namespace}/at/{activity-type}/ai/{activity-id}/ri/{run-id}/d/{hash-algorithm}/{hex-digest}
```

Fallback object name (unknown target):

```text
v0/d/{hash-algorithm}/{hex-digest}
```

- If no namespace, workflow, or activity information is available, the fallback is used.
- Dynamic path segments are encoded per the rules below.
- Missing values (including a missing `run-id`) are encoded as `null`.
- `hex-digest` is lower-case SHA-256 hex (64 characters).

### Encoding rules

GCS object names accept any Unicode, so the Temporal SDKs leave readable characters intact and percent-encode only what Google forbids or discourages: https://cloud.google.com/storage/docs/objects#naming

Encoded characters:

```text
Carriage return, line feed, and other control characters (U+0000–U+001F, U+007F–U+009F)
The discouraged set: # [ ] * ? : " < > |
Forward slash (/), so a value cannot introduce extra path segments
Percent (%), so the encoding stays reversible
```

A segment that is exactly `.` or `..` (both reserved by GCS) is encoded as `%2E` and `%2E%2E` respectively.

### Examples

Workflow object name example:

```text
input:
  namespace=payments prod
  workflow-type=ChargeWorkflow
  workflow-id=order+123=abc
  run-id=3f1d6c7a-8b2e-4f7a-9d0a-87a6f95e4d31
  hash-algorithm=sha256
  hex-digest=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08

output:
  v0/ns/payments prod/wt/ChargeWorkflow/wi/order+123=abc/ri/3f1d6c7a-8b2e-4f7a-9d0a-87a6f95e4d31/d/sha256/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

Activity object name example:

```text
input:
  namespace=payments prod
  activity-type=Capture/Charge
  activity-id=activity id+42
  run-id=9e1d1fd9-2f8a-4c40-93e2-731f31b9268b
  hash-algorithm=sha256
  hex-digest=2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824

output:
  v0/ns/payments prod/at/Capture%2FCharge/ai/activity id+42/ri/9e1d1fd9-2f8a-4c40-93e2-731f31b9268b/d/sha256/2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
```
