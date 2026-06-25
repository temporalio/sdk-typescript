# Amazon S3 External Storage Driver for the Temporal TypeScript SDK

> ⚠️ **This package is experimental and may be subject to change.** ⚠️

`@temporalio/external-storage-s3` stores and retrieves Temporal payloads in Amazon S3 via the [External Storage](https://docs.temporal.io/external-storage) feature.

This package has no AWS dependency: it defines the driver and the `S3StorageDriverClient` interface, and you supply the S3 client. Use the companion [`@temporalio/external-storage-s3-aws-sdk`](../external-storage-s3-aws-sdk) package for an [`@aws-sdk/client-s3`](https://www.npmjs.com/package/@aws-sdk/client-s3)-backed client, or implement the interface yourself.

## Using the AWS SDK client

Install the adapter package alongside this one:

    npm install @temporalio/external-storage-s3 @temporalio/external-storage-s3-aws-sdk @aws-sdk/client-s3

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { S3StorageDriver } from '@temporalio/external-storage-s3';
import { AwsSdkS3StorageDriverClient } from '@temporalio/external-storage-s3-aws-sdk';

const s3Client = new S3Client({ region: 'us-east-1' });
const driver = new S3StorageDriver({
  client: new AwsSdkS3StorageDriverClient(s3Client),
  bucket: 'my-temporal-payloads',
});
```

Register the resulting driver with the SDK's External Storage configuration so the
client and worker offload eligible payloads to it.

## Custom S3 client implementations

To use a different S3 library, implement `S3StorageDriverClient`.

```ts
import type { S3StorageDriverClient } from '@temporalio/external-storage-s3';

const myClient: S3StorageDriverClient = {
  async putObject(bucket, key, data, options) {
    /* ... */
  },
  async objectExists(bucket, key, options) {
    /* ... */
    return false;
  },
  async getObject(bucket, key, options) {
    /* ... */
    return new Uint8Array();
  },
};
```

## Dynamic bucket selection

Pass a callable as `bucket` to choose the destination per payload:

```ts
const driver = new S3StorageDriver({
  client: new AwsSdkS3StorageDriverClient(s3Client),
  bucket: (_context, payload) => ((payload.data?.length ?? 0) > 10 * 1024 * 1024 ? 'large-payloads' : 'small-payloads'),
});
```

## Required IAM permissions

The credentials used by your S3 client must have these S3 permissions on the target bucket and its objects:

```json
{
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject"],
  "Resource": "arn:aws:s3:::my-temporal-payloads/*"
}
```

`s3:PutObject` is required by components that store payloads (typically the client and worker sending workflow/activity inputs); `s3:GetObject` is required by components that retrieve them. Components that only retrieve do not need `s3:PutObject`, and vice versa.

## S3 Storage Key Specification

All Temporal S3 drivers generate S3 keys in a consistent manner.

### Key format

Workflow key:

```text
v0/ns/{namespace}/wt/{workflow-type}/wi/{workflow-id}/ri/{run-id}/d/{hash-algorithm}/{hex-digest}
```

Activity key:

```text
v0/ns/{namespace}/at/{activity-type}/ai/{activity-id}/ri/{run-id}/d/{hash-algorithm}/{hex-digest}
```

Fallback key (unknown target):

```text
v0/d/{hash-algorithm}/{hex-digest}
```

- If no namespace, workflow, or activity information is available, the fallback is used.
- Dynamic path segments are percent-encoded (rules below).
- Missing values (including a missing `run-id`) are encoded as `null`.
- `hex-digest` is lower-case SHA-256 hex (64 characters).

### Percent-encoding rules

The Temporal SDKs escape anything that isn't listed in S3's safe character set: https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html

Safe Characters:

```text
Alphanumeric characters
  0-9
  a-z
  A-Z

Special characters
  Exclamation point (!)
  Hyphen (-)
  Underscore (_)
  Period (.)
  Asterisk (*)
  Single quotation mark (')
  Opening parenthesis (()
  Closing parenthesis ())
```

### Examples

Workflow key example:

```text
input:
  namespace=payments prod
  workflow-type=ChargeWorkflow
  workflow-id=order+123=abc
  run-id=3f1d6c7a-8b2e-4f7a-9d0a-87a6f95e4d31
  hash-algorithm=sha256
  hex-digest=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08

output:
  v0/ns/payments%20prod/wt/ChargeWorkflow/wi/order%2B123%3Dabc/ri/3f1d6c7a-8b2e-4f7a-9d0a-87a6f95e4d31/d/sha256/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

Activity key example:

```text
input:
  namespace=payments prod
  activity-type=Capture/Charge
  activity-id=activity id+42
  run-id=9e1d1fd9-2f8a-4c40-93e2-731f31b9268b
  hash-algorithm=sha256
  hex-digest=2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824

output:
  v0/ns/payments%20prod/at/Capture%2FCharge/ai/activity%20id%2B42/ri/9e1d1fd9-2f8a-4c40-93e2-731f31b9268b/d/sha256/2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
```
