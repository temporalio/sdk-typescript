# AWS SDK Client for the Temporal S3 External Storage Driver

> ⚠️ **This package is experimental and may be subject to change.** ⚠️

`@temporalio/external-storage-s3-aws-sdk` provides an [`@aws-sdk/client-s3`](https://www.npmjs.com/package/@aws-sdk/client-s3)-backed `S3StorageDriverClient` for [`@temporalio/external-storage-s3`](../external-storage-s3).

`@aws-sdk/client-s3` is a peer dependency, so the driver uses the same `S3Client` (and version) your application already configures.

## Usage

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
