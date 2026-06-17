import { createHash } from 'node:crypto';
import * as proto from '@temporalio/proto';
import { ValueError } from '@temporalio/common';
import type { Payload } from '@temporalio/common';
import {
  StorageDriverClaim,
  type StorageDriver,
  type StorageDriverStoreContext,
  type StorageDriverRetrieveContext,
  type StorageDriverTargetInfo,
} from '@temporalio/common/lib/converter/extstore';
import type { S3StorageDriverClient } from './client';

const PayloadProto = proto.temporal.api.common.v1.Payload;

const DRIVER_TYPE = 'aws.s3driver';
const DEFAULT_MAX_PAYLOAD_SIZE = 50 * 1024 * 1024;

/** Picks the destination bucket for a given payload. Enables dynamic per-payload routing. */
export type BucketSelector = (context: StorageDriverStoreContext, payload: Payload) => string;

/** @experimental */
export interface S3StorageDriverOptions {
  /**
   * An {@link S3StorageDriverClient} that performs the underlying requests,
   * e.g. an `AwsSdkS3StorageDriverClient`.
   */
  client: S3StorageDriverClient;
  /** Static bucket name or a {@link BucketSelector}. */
  bucket: string | BucketSelector;
  /**
   * Per-instance routing name written into the wire format. Defaults to
   * `"aws.s3driver"`. Override only when registering multiple S3 drivers with
   * distinct configurations under the same `ExternalStorage.drivers` list.
   */
  driverName?: string;
  /**
   * Hard upper limit, in bytes, on the serialized size of a single payload.
   * Defaults to 52428800 (50 MiB). Stores larger than this throw.
   */
  maxPayloadSize?: number;
}

/**
 * Percent-encodes a key segment, escaping everything outside S3's safe-character
 * set (alphanumerics and `! - _ . * ' ( )`). An empty or absent value becomes the
 * literal `null`.
 */
function encodeKeySegment(value: string | undefined): string {
  if (!value) return 'null';
  return encodeURIComponent(value).replace(/~/g, '%7E');
}

function buildContextSegments(target: StorageDriverTargetInfo | undefined): string {
  if (target?.kind === 'workflow') {
    return (
      `/ns/${encodeKeySegment(target.namespace)}` +
      `/wt/${encodeKeySegment(target.type)}` +
      `/wi/${encodeKeySegment(target.id)}` +
      `/ri/${encodeKeySegment(target.runId)}`
    );
  }
  if (target?.kind === 'activity') {
    return (
      `/ns/${encodeKeySegment(target.namespace)}` +
      `/at/${encodeKeySegment(target.type)}` +
      `/ai/${encodeKeySegment(target.id)}` +
      `/ri/${encodeKeySegment(target.runId)}`
    );
  }
  return '';
}

/**
 * Formats `describe()` output as ", k=v, k=v" for error messages. Returns an
 * empty string when the client reports no metadata or `describe` itself throws.
 */
function formatClientContext(client: S3StorageDriverClient): string {
  let info: Record<string, string>;
  try {
    info = client.describe?.() ?? {};
  } catch {
    return '';
  }
  const entries = Object.entries(info);
  return entries.map(([k, v]) => `, ${k}=${v}`).join('');
}

/**
 * Runs the per-payload operations concurrently. On the first failure, aborts the
 * shared signal so in-flight sibling requests are cancelled, then waits for them
 * to settle before propagating the original error.
 */
async function gatherWithCancellation<T>(
  external: AbortSignal | undefined,
  makeTasks: (signal: AbortSignal) => Promise<T>[]
): Promise<T[]> {
  const controller = new AbortController();
  const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
  const tasks = makeTasks(signal);
  try {
    return await Promise.all(tasks);
  } catch (err) {
    controller.abort();
    await Promise.allSettled(tasks);
    throw err;
  }
}

/**
 * Stores and retrieves Temporal payloads in Amazon S3.
 *
 * Payloads are content-addressed by a SHA-256 hash of their serialized bytes. S3 keys
 * are created using the namespace, workflow/activity type, other metadata from the store
 * context. Keys adhere to S3's safe-character set.
 *
 * @experimental
 */
export class S3StorageDriver implements StorageDriver {
  readonly name: string;
  readonly type = DRIVER_TYPE;
  private readonly client: S3StorageDriverClient;
  private readonly bucket: BucketSelector;
  private readonly maxPayloadSize: number;

  constructor(options: S3StorageDriverOptions) {
    const { client, bucket, driverName, maxPayloadSize = DEFAULT_MAX_PAYLOAD_SIZE } = options;
    if (!Number.isFinite(maxPayloadSize) || maxPayloadSize <= 0) {
      throw new ValueError(`maxPayloadSize must be a positive finite number, got ${String(maxPayloadSize)}`);
    }
    this.client = client;
    this.bucket = (typeof bucket === 'string') ? () => bucket : bucket;
    this.name = driverName || DRIVER_TYPE;
    this.maxPayloadSize = maxPayloadSize;
  }

  async store(context: StorageDriverStoreContext, payloads: Payload[]): Promise<StorageDriverClaim[]> {
    const contextSegments = buildContextSegments(context.target);
    return gatherWithCancellation(context.abortSignal, (signal) =>
      payloads.map((payload) => this.upload(context, payload, contextSegments, signal))
    );
  }

  async retrieve(context: StorageDriverRetrieveContext, claims: StorageDriverClaim[]): Promise<Payload[]> {
    return gatherWithCancellation(context.abortSignal, (signal) =>
      claims.map((claim) => this.download(claim, signal))
    );
  }

  private async upload(
    context: StorageDriverStoreContext,
    payload: Payload,
    contextSegments: string,
    abortSignal: AbortSignal
  ): Promise<StorageDriverClaim> {
    const bucket = this.bucket(context, payload);

    const payloadBytes = PayloadProto.encode(payload).finish();
    if (payloadBytes.length > this.maxPayloadSize) {
      throw new ValueError(
        `Payload size ${payloadBytes.length} bytes exceeds the configured maxPayloadSize of ${this.maxPayloadSize} bytes`
      );
    }

    const hashValue = createHash('sha256').update(payloadBytes).digest('hex');
    const key = `v0${contextSegments}/d/sha256/${hashValue}`;

    try {
      if (!(await this.client.objectExists(bucket, key, { abortSignal }))) {
        await this.client.putObject(bucket, key, payloadBytes, { abortSignal });
      }
    } catch (err) {
      throw new Error(
        `S3StorageDriver store failed [bucket=${bucket}, key=${key}${formatClientContext(this.client)}]`,
        { cause: err }
      );
    }

    return new StorageDriverClaim({ bucket, key, hashAlgorithm: 'sha256', hashValue });
  }

  private async download(claim: StorageDriverClaim, abortSignal: AbortSignal): Promise<Payload> {
    const { bucket, key, hashAlgorithm, hashValue: expectedHash } = claim.claimData;
    if (!bucket || !key) {
      throw new ValueError(
        `S3StorageDriver claim is missing required location information: ` +
          `claimData must contain 'bucket' and 'key'`
      );
    }
    if (!hashAlgorithm || !expectedHash) {
      throw new ValueError(
        `S3StorageDriver claim is missing required content hash information [bucket=${bucket}, key=${key}]: ` +
          `claimData must contain 'hashAlgorithm' and 'hashValue'`
      );
    }
    if (hashAlgorithm !== 'sha256') {
      throw new ValueError(
        `S3StorageDriver unsupported hash algorithm [bucket=${bucket}, key=${key}]: expected sha256, got ${hashAlgorithm}`
      );
    }

    let payloadBytes: Uint8Array;
    try {
      payloadBytes = await this.client.getObject(bucket, key, { abortSignal });
    } catch (err) {
      throw new Error(
        `S3StorageDriver retrieve failed [bucket=${bucket}, key=${key}${formatClientContext(this.client)}]`,
        { cause: err }
      );
    }

    const actualHash = createHash('sha256').update(payloadBytes).digest('hex');
    if (actualHash !== expectedHash) {
      throw new ValueError(
        `S3StorageDriver integrity check failed [bucket=${bucket}, key=${key}]: ` +
          `expected ${hashAlgorithm}:${expectedHash}, got ${hashAlgorithm}:${actualHash}`
      );
    }

    return PayloadProto.decode(payloadBytes);
  }
}
