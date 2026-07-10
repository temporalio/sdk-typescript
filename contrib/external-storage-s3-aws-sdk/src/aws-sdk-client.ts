import { PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { S3StorageDriverClient, S3RequestOptions } from '@temporalio/external-storage-s3';

/**
 * An {@link S3StorageDriverClient} backed by an `@aws-sdk/client-s3` `S3Client`,
 * for use with `S3StorageDriver`.
 *
 * @experimental
 */
export class AwsSdkS3StorageDriverClient implements S3StorageDriverClient {
  constructor(private readonly client: S3Client) {}

  describe(): Record<string, string> {
    const region = this.client.config?.region;
    return typeof region === 'string' && region ? { clientRegion: region } : {};
  }

  async objectExists(bucket: string, key: string, options?: S3RequestOptions): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: options?.abortSignal,
      });
      return true;
    } catch (err) {
      if (isNotFound(err)) {
        return false;
      }
      throw err;
    }
  }

  async putObject(bucket: string, key: string, data: Uint8Array, options?: S3RequestOptions): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data }), {
      abortSignal: options?.abortSignal,
    });
  }

  async getObject(bucket: string, key: string, options?: S3RequestOptions): Promise<Uint8Array> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: options?.abortSignal,
    });
    if (!response.Body) {
      throw new Error(`S3 GetObject returned an empty body [bucket=${bucket}, key=${key}]`);
    }
    return response.Body.transformToByteArray();
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}
