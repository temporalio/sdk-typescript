/** Builds payload visitor options backed by one {@link ExternalStorageRunner} per visit. @module */
import type { WalkEnv } from '@temporalio/proto/internal/payload-visitor.generated';
import { unbounded } from '../concurrency/limit';
import type { LoadedDataConverter } from '../converter/data-converter';
import type { ExternalStorage, StorageDriverTargetInfo } from '../converter/extstore';
import type { PayloadCodec } from '../converter/payload-codec';
import type { SerializationContext } from '../converter/serialization-context';
import { ExternalStorageNotConfiguredError } from '../errors';
import type { Payload } from '../interfaces';
import type { Logger } from '../logger';
import type { PayloadCache } from '../payload-cache';
import { decode } from './codec-helpers';
import type { ExternalStorageMetricsAccumulator } from './external-storage-metrics';
import { ExternalStorageRunner } from './external-storage-runner';
import { hasReferenceMarker, isReferencePayload, undecodableReferenceError } from './extstore-helpers';
import { visit, type ContextDeriver, type VisitOptions } from './payload-visitor';

/**
 * The storage target in scope at a given payload site during a store walk. It starts at
 * {@link ExternalStorageStoreVisitOptions.initialTarget} and {@link ExternalStorageStoreVisitOptions.deriveContext}
 * may retarget it per message (e.g. a child-workflow command retargets its payloads at the child).
 */
type StoreTarget = StorageDriverTargetInfo | undefined;

/** @internal @experimental */
export interface ExternalStorageStoreVisitOptions {
  /** External Storage configuration used to create the runner for this visit. */
  externalStorage: ExternalStorage;
  /** Namespace of the client or worker performing the store. */
  namespace: string;
  /** Storage target before any message is entered (the initial enclosing workflow / activity). */
  initialTarget?: StorageDriverTargetInfo;
  /** Derives new storage target from the current message. */
  deriveContext?: ContextDeriver<StoreTarget>;
  /** Aborts the walk and every in-flight driver call. */
  abortSignal?: AbortSignal;
  /** Collects metrics for store operations performed during the walk. */
  metrics?: ExternalStorageMetricsAccumulator;
  /** Cache shared across visits, or `false` to disable caching. */
  payloadCache: PayloadCache | false;
  logger?: Logger;
}

/**
 * Creates one runner for a store visit. Stable dependencies such as `payloadCache` may be shared across visits.
 *
 * @internal
 * @experimental
 */
export function externalStorageStoreVisitOptions({
  externalStorage,
  namespace,
  initialTarget,
  deriveContext,
  abortSignal,
  metrics,
  payloadCache,
  logger,
}: ExternalStorageStoreVisitOptions): VisitOptions<StoreTarget> {
  const runner = new ExternalStorageRunner(externalStorage, { payloadCache, logger });
  return {
    transformPayloads: (payloads, target, signal) =>
      runner.store(payloads, { target, namespace, abortSignal: signal, metrics }),
    transformPayload: (payload, target, signal) =>
      runner.store([payload], { target, namespace, abortSignal: signal, metrics }).then((stored) => stored[0]!),
    deriveContext,
    initialContext: initialTarget,
    // Search attributes must keep their literal values so the server can index/search on them.
    skipSearchAttributes: true,
    limit: unbounded(),
    abortSignal,
  };
}

/** @internal @experimental */
export interface ExternalStorageRetrieveVisitOptions {
  /** External Storage configuration, or `undefined` to reject reference payloads. */
  externalStorage: ExternalStorage | undefined;
  /** Aborts the walk and every in-flight driver call. */
  abortSignal?: AbortSignal;
  /** Collects metrics for retrieve operations performed during the walk. */
  metrics?: ExternalStorageMetricsAccumulator;
  /** Cache shared across visits, or `false` to disable caching. */
  payloadCache: PayloadCache | false;
  logger?: Logger;
}

/**
 * Detection-only visit used when no External Storage runner is available: leaves every payload
 * untouched but throws {@link ExternalStorageNotConfiguredError} on the first reference payload,
 * marked or not.
 */
function externalStorageReferenceDetectionVisitOptions(): VisitOptions<void> {
  const assertNoReference = (payloads: Payload[]): Payload[] => {
    if (payloads.some((payload) => isReferencePayload(payload) || hasReferenceMarker(payload))) {
      throw new ExternalStorageNotConfiguredError();
    }
    return payloads;
  };
  return {
    transformPayloads: (payloads) => Promise.resolve(assertNoReference(payloads)),
    transformPayload: (payload) => Promise.resolve(assertNoReference([payload])[0]!),
    skipSearchAttributes: true,
  };
}

/**
 * Creates one runner for a retrieve visit. Stable dependencies such as `payloadCache` may be shared across visits.
 * When External Storage is not configured, returns options that reject reference payloads.
 *
 * @internal
 * @experimental
 */
export function externalStorageRetrieveVisitOptions({
  externalStorage,
  abortSignal,
  metrics,
  payloadCache,
  logger,
}: ExternalStorageRetrieveVisitOptions): VisitOptions<void> {
  if (externalStorage === undefined) return externalStorageReferenceDetectionVisitOptions();
  const runner = new ExternalStorageRunner(externalStorage, { payloadCache, logger });
  return {
    transformPayloads: (payloads, _context, signal) => runner.retrieve(payloads, { abortSignal: signal, metrics }),
    transformPayload: (payload, _context, signal) =>
      runner.retrieve([payload], { abortSignal: signal, metrics }).then((retrieved) => retrieved[0]!),
    skipSearchAttributes: true,
    limit: unbounded(),
    abortSignal,
  };
}

/** @internal @experimental */
export interface ExternalStorageReferenceDecodeVisitOptions {
  /** External Storage configuration, or `undefined` to reject marked reference payloads. */
  externalStorage: ExternalStorage | undefined;
  /** Payload codecs that encoded the references. */
  codecs: PayloadCodec[];
  /** Serialization context before any message is entered. */
  initialContext?: SerializationContext;
  /** Derives the serialization context the SDK decodes each message's payloads with. */
  deriveContext?: ContextDeriver<SerializationContext | undefined>;
  /** Matches the codec walk on this path: headers are skipped unless the codecs decode them. Defaults to `true`. */
  skipHeaders?: boolean;
}

/**
 * Must run before {@link externalStorageRetrieveVisitOptions}, which can only read decoded references.
 * Skip this visit when there are no codecs, as {@link decodeExternalStorageReferences} does.
 *
 * References are decoded one at a time, as codecs are not run concurrently elsewhere.
 *
 * @internal
 * @experimental
 */
export function externalStorageReferenceDecodeVisitOptions({
  externalStorage,
  codecs,
  initialContext,
  deriveContext,
  skipHeaders = true,
}: ExternalStorageReferenceDecodeVisitOptions): VisitOptions<SerializationContext | undefined> {
  const decodeReferences = (payloads: Payload[], context: SerializationContext | undefined) =>
    decodeReferencePayloads(payloads, codecs, context, externalStorage !== undefined);
  return {
    transformPayloads: decodeReferences,
    transformPayload: (payload, context) => decodeReferences([payload], context).then((decoded) => decoded[0]!),
    deriveContext,
    initialContext,
    skipHeaders,
    skipSearchAttributes: true,
  };
}

/**
 * Decodes the encoded External Storage references in `message` with the data converter's codecs.
 * Does nothing without codecs: there is nothing to decode, and the retrieve visit rejects a marked
 * payload that is not a plain reference.
 *
 * @internal
 * @experimental
 */
export async function decodeExternalStorageReferences<Root>(
  message: Root,
  walk: (
    root: Root,
    env: WalkEnv<SerializationContext | undefined>,
    context: SerializationContext | undefined
  ) => Promise<unknown>[],
  dataConverter: Pick<LoadedDataConverter, 'externalStorage' | 'payloadCodecs'>,
  options: Pick<ExternalStorageReferenceDecodeVisitOptions, 'initialContext' | 'deriveContext' | 'skipHeaders'> = {}
): Promise<void> {
  if (dataConverter.payloadCodecs.length === 0) return;
  await visit(
    message,
    walk,
    externalStorageReferenceDecodeVisitOptions({
      externalStorage: dataConverter.externalStorage,
      codecs: dataConverter.payloadCodecs,
      ...options,
    })
  );
}

async function decodeReferencePayloads(
  payloads: Payload[],
  codecs: PayloadCodec[],
  context: SerializationContext | undefined,
  storageConfigured: boolean
): Promise<Payload[]> {
  const decoded: Payload[] = [];
  for (const payload of payloads) {
    if (!hasReferenceMarker(payload)) {
      decoded.push(payload);
      continue;
    }
    // Nothing could retrieve the reference, so fail before decoding it.
    if (!storageConfigured) throw new ExternalStorageNotConfiguredError();
    // The marker and externalPayloads stay on the payload the codec decodes. A codec must tolerate
    // them, because codec servers receive payloads exactly as they appear in history.
    const [reference] = await decode(codecs, [payload], context);
    if (reference === undefined || !isReferencePayload(reference)) throw undecodableReferenceError();
    decoded.push(
      reference.externalPayloads?.length ? reference : { ...reference, externalPayloads: payload.externalPayloads }
    );
  }
  return decoded;
}
