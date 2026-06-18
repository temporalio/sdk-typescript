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
import type { GcsStorageDriverClient } from './client';

const PayloadProto = proto.temporal.api.common.v1.Payload;

const DRIVER_TYPE = 'gcp.gcsdriver';
const DEFAULT_MAX_PAYLOAD_SIZE = 50 * 1024 * 1024;

/** Picks the destination bucket for a given payload. Enables dynamic per-payload routing. */
export type BucketSelector = (context: StorageDriverStoreContext, payload: Payload) => string;

/** @experimental */
export interface GcsStorageDriverOptions {
  /**
   * A {@link GcsStorageDriverClient} that performs the underlying requests,
   * e.g. a `GoogleCloudGcsStorageDriverClient`.
   */
  client: GcsStorageDriverClient;
  /** Static bucket name or a {@link BucketSelector}. */
  bucket: string | BucketSelector;
  /**
   * Per-instance routing name written into the wire format. Defaults to
   * `"gcp.gcsdriver"`. Override only when registering multiple GCS drivers with
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
 * GCS object names accept any Unicode, but Google forbids carriage-return and
 * line-feed and the literal segments `.` and `..`, and strongly recommends
 * avoiding `# [ ] * ? : " < > |` and control characters. This escapes only that
 * set, plus `/` (so a value cannot introduce extra path segments) and `%` (so the
 * encoding stays injective), leaving readable Unicode intact.
 * See https://cloud.google.com/storage/docs/objects#naming.
 */
// eslint-disable-next-line no-control-regex -- intentionally matches the control characters GCS recommends avoiding
const GCS_UNSAFE_SEGMENT = /[\u0000-\u001f\u007f-\u009f#[\]*?:"<>|/%]/g;

function percentEncodeChar(char: string): string {
  let encoded = '';
  for (const byte of new TextEncoder().encode(char)) {
    encoded += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return encoded;
}

function encodeObjectNameSegment(value: string | undefined): string {
  if (!value) return 'null';
  const encoded = value.replace(GCS_UNSAFE_SEGMENT, percentEncodeChar);
  if (encoded === '.') return '%2E';
  if (encoded === '..') return '%2E%2E';
  return encoded;
}

function buildContextSegments(target: StorageDriverTargetInfo | undefined): string {
  if (target?.kind === 'workflow') {
    return (
      `/ns/${encodeObjectNameSegment(target.namespace)}` +
      `/wt/${encodeObjectNameSegment(target.type)}` +
      `/wi/${encodeObjectNameSegment(target.id)}` +
      `/ri/${encodeObjectNameSegment(target.runId)}`
    );
  }
  if (target?.kind === 'activity') {
    return (
      `/ns/${encodeObjectNameSegment(target.namespace)}` +
      `/at/${encodeObjectNameSegment(target.type)}` +
      `/ai/${encodeObjectNameSegment(target.id)}` +
      `/ri/${encodeObjectNameSegment(target.runId)}`
    );
  }
  return '';
}

/**
 * Formats `describe()` output as ", k=v, k=v" for error messages. Returns an
 * empty string when the client reports no metadata or `describe` itself throws.
 */
function formatClientContext(client: GcsStorageDriverClient): string {
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
 * Awaits every task, even when one rejects, so no request is left running in the
 * background, then surfaces the first rejection (or all results when none fail).
 */
async function allSettledOrThrow<T>(tasks: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks);
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected) throw rejected.reason;
  return (results as PromiseFulfilledResult<T>[]).map((r) => r.value);
}

/**
 * Stores and retrieves Temporal payloads in Google Cloud Storage.
 *
 * Payloads are content-addressed by a SHA-256 hash of their serialized bytes. Object
 * names are created using the namespace, workflow/activity type, and other metadata
 * from the store context.
 *
 * @experimental
 */
export class GcsStorageDriver implements StorageDriver {
  readonly name: string;
  readonly type = DRIVER_TYPE;
  private readonly client: GcsStorageDriverClient;
  private readonly bucket: BucketSelector;
  private readonly maxPayloadSize: number;

  constructor(options: GcsStorageDriverOptions) {
    const { client, bucket, driverName, maxPayloadSize = DEFAULT_MAX_PAYLOAD_SIZE } = options;
    if (!Number.isFinite(maxPayloadSize) || maxPayloadSize <= 0) {
      throw new ValueError(`maxPayloadSize must be a positive finite number, got ${String(maxPayloadSize)}`);
    }
    this.client = client;
    this.bucket = typeof bucket === 'string' ? () => bucket : bucket;
    this.name = driverName || DRIVER_TYPE;
    this.maxPayloadSize = maxPayloadSize;
  }

  async store(context: StorageDriverStoreContext, payloads: Payload[]): Promise<StorageDriverClaim[]> {
    const contextSegments = buildContextSegments(context.target);
    return allSettledOrThrow(
      payloads.map((payload) => this.storePayload(context, payload, contextSegments, context.abortSignal))
    );
  }

  async retrieve(context: StorageDriverRetrieveContext, claims: StorageDriverClaim[]): Promise<Payload[]> {
    return allSettledOrThrow(claims.map((claim) => this.retrievePayload(claim, context.abortSignal)));
  }

  private async storePayload(
    context: StorageDriverStoreContext,
    payload: Payload,
    contextSegments: string,
    abortSignal: AbortSignal | undefined
  ): Promise<StorageDriverClaim> {
    const bucket = this.bucket(context, payload);

    const payloadBytes = PayloadProto.encode(payload).finish();
    if (payloadBytes.length > this.maxPayloadSize) {
      throw new ValueError(
        `Payload size ${payloadBytes.length} bytes exceeds the configured maxPayloadSize of ${this.maxPayloadSize} bytes`
      );
    }

    const hashValue = createHash('sha256').update(payloadBytes).digest('hex');
    const object = `v0${contextSegments}/d/sha256/${hashValue}`;

    try {
      await this.client.save(bucket, object, payloadBytes, { abortSignal });
    } catch (err) {
      throw new Error(
        `GcsStorageDriver store failed [bucket=${bucket}, object=${object}${formatClientContext(this.client)}]`,
        { cause: err }
      );
    }

    return new StorageDriverClaim({ bucket, object, hashAlgorithm: 'sha256', hashValue });
  }

  private async retrievePayload(claim: StorageDriverClaim, abortSignal: AbortSignal | undefined): Promise<Payload> {
    const { bucket, object, hashAlgorithm, hashValue: expectedHash } = claim.claimData;
    if (!bucket || !object) {
      throw new ValueError(
        `GcsStorageDriver claim is missing required location information: ` +
          `claimData must contain 'bucket' and 'object'`
      );
    }
    if (!hashAlgorithm || !expectedHash) {
      throw new ValueError(
        `GcsStorageDriver claim is missing required content hash information [bucket=${bucket}, object=${object}]: ` +
          `claimData must contain 'hashAlgorithm' and 'hashValue'`
      );
    }
    if (hashAlgorithm !== 'sha256') {
      throw new ValueError(
        `GcsStorageDriver unsupported hash algorithm [bucket=${bucket}, object=${object}]: expected sha256, got ${hashAlgorithm}`
      );
    }

    let payloadBytes: Uint8Array;
    try {
      payloadBytes = await this.client.download(bucket, object, { abortSignal });
    } catch (err) {
      throw new Error(
        `GcsStorageDriver retrieve failed [bucket=${bucket}, object=${object}${formatClientContext(this.client)}]`,
        { cause: err }
      );
    }

    const actualHash = createHash('sha256').update(payloadBytes).digest('hex');
    if (actualHash !== expectedHash) {
      throw new ValueError(
        `GcsStorageDriver integrity check failed [bucket=${bucket}, object=${object}]: ` +
          `expected ${hashAlgorithm}:${expectedHash}, got ${hashAlgorithm}:${actualHash}`
      );
    }

    return PayloadProto.decode(payloadBytes);
  }
}
