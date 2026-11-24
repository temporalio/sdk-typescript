import { createPrivateKey, X509Certificate } from 'node:crypto';
import type { MetricTags } from '@temporalio/common';
import type { Fetcher, SecretValue } from './fetch';
import { FETCH_TIMEOUT_MS } from './fetch';
import type { FailureReason, LookupResult, SecretType, Telemetry } from './telemetry';
import {
  classifyFailure,
  FetchTimeoutError,
  InvalidResponseError,
  LABEL_FAILURE_REASON,
  LABEL_FALLBACK,
  LABEL_FETCH_PATH,
  LABEL_OUTCOME,
  LABEL_RESULT,
  LABEL_SECRET_TYPE,
} from './telemetry';

/**
 * After a failed refresh falls back to a stale value, wait this long before trying again so that an
 * outage doesn't add a fetch attempt to every credential lookup.
 */
export const FAILED_REFRESH_RETRY_INTERVAL_MS = 30_000;

const CERT_PEM_RE = /-----BEGIN CERTIFICATE-----\r?\n[\s\S]*?-----END CERTIFICATE-----/g;
const KEY_PEM_RE = /-----BEGIN ((?:RSA |EC )?PRIVATE KEY)-----\r?\n[\s\S]*?-----END \1-----/;

/** A failed fetch of one or more secrets, with its failure_reason label. */
export class SecretFetchError extends Error {
  override name = 'SecretFetchError';

  constructor(
    message: string,
    readonly reason: FailureReason,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

/** Configured secret IDs. Empty strings are unset. */
export interface SecretIDs {
  apiKey: string;
  clientCert: string;
  clientKey: string;
  serverCACert: string;
}

export function hasTLS(ids: SecretIDs): boolean {
  return !!(ids.clientCert || ids.clientKey || ids.serverCACert);
}

interface SecretRef {
  id: string;
  secretType: SecretType;
}

/** A client cert and key, as PEM. */
export interface ClientCertPair {
  crt: Buffer;
  key: Buffer;
}

/** One or more secrets that are fetched and replaced together, cached as a single parsed value. */
export class CacheEntry<T> {
  /** The fetch in progress, if any */
  inFlight?: Promise<T>;
  /** In refs order, undefined until the first successful fetch */
  versionIds?: string[];
  value?: T;
  fetchedAt = 0;
  /** Last failed fetch since the last successful fetch, if any */
  failedAt?: number;

  /**
   * `refs` are distinct secret IDs, and `refs[0].secretType` is used as the secret_type metric
   * label. `parse` is called on newly fetched secrets (in `refs` order) to produce the cached value,
   * and should throw {@link InvalidResponseError} if they're invalid.
   */
  constructor(
    readonly refs: SecretRef[],
    readonly parse: (secrets: SecretValue[]) => T
  ) {}
}

/**
 * TTL cache of the configured credentials that falls back to the last fetched value, up to
 * `maxStalenessMs` old, when a refresh fails.
 */
export class SecretCache {
  /** How long callers wait for a fetch before falling back or failing */
  fetchTimeoutMs = FETCH_TIMEOUT_MS;
  /** Monotonic milliseconds, overridable in tests */
  now: () => number = () => performance.now();

  readonly apiKey?: CacheEntry<string>;
  /** Client cert and key, fetched and replaced together to prevent (cache-level) tearing on rotations */
  readonly clientCert?: CacheEntry<ClientCertPair>;
  readonly serverCACert?: CacheEntry<Buffer>;

  constructor(
    readonly fetcher: Fetcher,
    ids: SecretIDs,
    readonly refreshIntervalMs: number,
    readonly maxStalenessMs: number
  ) {
    if (ids.apiKey) {
      this.apiKey = new CacheEntry([{ id: ids.apiKey, secretType: 'api_key' }], parseAPIKey);
    }
    if (ids.clientCert) {
      this.clientCert = newClientCertEntry(ids.clientCert, ids.clientKey);
    }
    if (ids.serverCACert) {
      this.serverCACert = newServerCACertEntry(ids.serverCACert);
    }
  }

  /**
   * Gets an entry's value, fetching it if needed. Returned values are shared across callers and
   * must not be mutated.
   */
  async get<T>(entry: CacheEntry<T>, tel: Telemetry): Promise<T> {
    // Read lazily, since the fetch path may only be known after a fetch
    const recordLookup = (result: LookupResult) =>
      tel.record(() => tel.cacheLookup.add(1, { ...this.baseTags(entry), [LABEL_RESULT]: result }));

    // Check for a usable value in the cache
    const now = this.now();
    const hasValue = entry.versionIds !== undefined;
    const canUseStale = hasValue && now - entry.fetchedAt < this.maxStalenessMs;
    const cached = entry.value as T;
    if (
      (hasValue && now - entry.fetchedAt < this.refreshIntervalMs) ||
      // Another caller is refreshing, so the current value is still the latest known one
      (canUseStale && entry.inFlight !== undefined)
    ) {
      recordLookup('hit');
      return cached;
    }
    if (canUseStale && entry.failedAt !== undefined && now - entry.failedAt < FAILED_REFRESH_RETRY_INTERVAL_MS) {
      recordLookup('miss_with_fallback');
      return cached;
    }

    // Wait for a fetch, starting one if none is in progress
    let fetch = entry.inFlight;
    if (fetch === undefined) {
      fetch = this.refresh(entry, now, canUseStale, tel).finally(() => {
        entry.inFlight = undefined;
      });
      entry.inFlight = fetch;
    }

    let value: T;
    try {
      value = await withTimeout(fetch, this.fetchTimeoutMs);
    } catch (err) {
      if (canUseStale) {
        recordLookup('miss_with_fallback');
        return cached;
      }
      throw err;
    }
    recordLookup('miss');
    return value;
  }

  /**
   * Returns an entry's current value without waiting, and starts refreshing it in the background if
   * it's due.
   *
   * The value is refreshed at most every `minRefreshIntervalMs`. If refreshing fails, the current
   * value keeps being returned until it's older than the max staleness, and then undefined is
   * returned until a refresh succeeds.
   *
   * Since callers can't wait for a refresh, a value older than the max staleness is still returned
   * until a refresh has actually been tried and failed. Otherwise callers would get no value while
   * a healthy refresh is in progress, e.g. when the value was due for refresh right at the max
   * staleness, or wasn't looked up at all for longer than that.
   */
  getNow<T>(entry: CacheEntry<T>, minRefreshIntervalMs: number, tel: Telemetry): T | undefined {
    const now = this.now();
    if (
      entry.inFlight === undefined &&
      now - entry.fetchedAt >= Math.max(this.refreshIntervalMs, minRefreshIntervalMs) &&
      (entry.failedAt === undefined || now - entry.failedAt >= FAILED_REFRESH_RETRY_INTERVAL_MS)
    ) {
      // Failures are already logged and counted by the cache
      this.get(entry, tel).catch(() => undefined);
    }
    // No value, or it's older than the max staleness and a refresh tried since then failed
    const expiresAt = entry.fetchedAt + this.maxStalenessMs;
    if (entry.versionIds === undefined || (now >= expiresAt && (entry.failedAt ?? -Infinity) >= expiresAt)) {
      return undefined;
    }
    return entry.value;
  }

  private baseTags(entry: CacheEntry<unknown>): MetricTags {
    return { [LABEL_SECRET_TYPE]: entry.refs[0]!.secretType, [LABEL_FETCH_PATH]: this.fetcher.path };
  }

  /** Fetches an entry's secrets and records the outcome in the cache. */
  private async refresh<T>(entry: CacheEntry<T>, start: number, canUseStale: boolean, tel: Telemetry): Promise<T> {
    let result: { value: T; versionIds: string[] } | SecretFetchError;
    try {
      result = await this.fetch(entry);
    } catch (err) {
      // fetch only throws SecretFetchError, but anything else must still be recorded as a failed
      // fetch rather than cached as the value
      result = err instanceof SecretFetchError ? err : new SecretFetchError(errorMessage(err), 'other', { cause: err });
    }
    const latencyMs = this.now() - start;

    const prevVersionIds = entry.versionIds;
    const prevFetchedAt = entry.fetchedAt;
    const prevFailed = entry.failedAt !== undefined;
    if (result instanceof SecretFetchError) {
      entry.failedAt = start;
    } else {
      entry.value = result.value;
      entry.versionIds = result.versionIds;
      entry.fetchedAt = start;
      entry.failedAt = undefined;
    }

    const baseTags = this.baseTags(entry);
    if (result instanceof SecretFetchError) {
      tel.record(() => tel.fetchLatency.record(Math.round(latencyMs), { ...baseTags, [LABEL_OUTCOME]: 'failure' }));
      tel.record(() =>
        tel.fetchFailed.add(1, {
          ...baseTags,
          [LABEL_FAILURE_REASON]: result.reason,
          [LABEL_FALLBACK]: canUseStale ? 'stale' : 'none',
        })
      );
      if (canUseStale) {
        for (const ref of entry.refs) {
          tel.record(() =>
            tel.logger?.warn('Failed refreshing AWS Secrets Manager secret, using previously fetched value', {
              secretId: ref.id,
              secretType: ref.secretType,
              error: result.message,
              ageMs: Math.round(start - prevFetchedAt),
              maxStalenessMs: this.maxStalenessMs,
            })
          );
        }
      }
      throw result;
    }

    tel.record(() => tel.fetchLatency.record(Math.round(latencyMs), { ...baseTags, [LABEL_OUTCOME]: 'success' }));
    entry.refs.forEach((ref, i) => {
      if (prevVersionIds === undefined) {
        tel.record(() =>
          tel.logger?.info('Fetched AWS Secrets Manager secret', {
            secretId: ref.id,
            secretType: ref.secretType,
            fetchPath: this.fetcher.path,
            versionId: result.versionIds[i],
          })
        );
      } else if (prevFailed || result.versionIds[i] !== prevVersionIds[i]) {
        tel.record(() =>
          tel.logger?.info('Fetched updated AWS Secrets Manager secret', {
            secretId: ref.id,
            secretType: ref.secretType,
            previousVersionId: prevVersionIds[i],
            versionId: result.versionIds[i],
          })
        );
      }
    });
    return result.value;
  }

  /** Fetches all of an entry's secrets and parses them. */
  private async fetch<T>(entry: CacheEntry<T>): Promise<{ value: T; versionIds: string[] }> {
    const secrets: SecretValue[] = [];
    for (const ref of entry.refs) {
      try {
        secrets.push(await this.fetcher.fetch(ref.id));
      } catch (err) {
        throw new SecretFetchError(
          `failed fetching AWS Secrets Manager secret "${ref.id}": ${errorMessage(err)}`,
          classifyFailure(err),
          { cause: err }
        );
      }
    }
    let value: T;
    try {
      value = entry.parse(secrets);
    } catch (err) {
      throw new SecretFetchError(
        errorMessage(err),
        err instanceof InvalidResponseError ? 'invalid_response' : 'other',
        {
          cause: err,
        }
      );
    }
    return { value, versionIds: secrets.map((s) => s.versionId) };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new FetchTimeoutError(`timed out after ${timeoutMs}ms waiting for AWS Secrets Manager secret fetch`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseAPIKey(secrets: SecretValue[]): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(secrets[0]!.value);
  } catch {
    throw new InvalidResponseError('API key secret is not valid UTF-8');
  }
}

function pemCerts(pem: string): string[] {
  return pem.match(CERT_PEM_RE) ?? [];
}

/**
 * Entry for the client cert and key, which may be the same secret if bundled. Each secret's relevant
 * PEM blocks are extracted, so a bundled secret can be used as both. A newly fetched pair that
 * doesn't match (e.g. fetched partway through rotating separate cert and key secrets) is treated as
 * a failed fetch, so the previous pair keeps being used.
 */
function newClientCertEntry(certId: string, keyId: string): CacheEntry<ClientCertPair> {
  const refs: SecretRef[] = [{ id: certId, secretType: 'tls_client_cert' }];
  if (keyId !== certId) {
    refs.push({ id: keyId, secretType: 'tls_client_key' });
  }
  return new CacheEntry(refs, (secrets) => {
    const certs = pemCerts(secrets[0]!.value.toString());
    if (certs.length === 0) {
      throw new InvalidResponseError(`no PEM certificate found in TLS client cert secret "${certId}"`);
    }
    const key = secrets[secrets.length - 1]!.value.toString().match(KEY_PEM_RE)?.[0];
    if (key === undefined) {
      throw new InvalidResponseError(`no PEM private key found in TLS client key secret "${keyId}"`);
    }
    let matches: boolean;
    try {
      matches = new X509Certificate(certs[0]!).checkPrivateKey(createPrivateKey(key));
    } catch (err) {
      throw new InvalidResponseError(
        `failed loading TLS client cert/key from AWS Secrets Manager secrets "${certId}" and "${keyId}": ${errorMessage(err)}`
      );
    }
    if (!matches) {
      throw new InvalidResponseError(
        `TLS client cert and key from AWS Secrets Manager secrets "${certId}" and "${keyId}" don't match`
      );
    }
    return { crt: Buffer.from(certs.join('\n') + '\n'), key: Buffer.from(key + '\n') };
  });
}

function newServerCACertEntry(secretId: string): CacheEntry<Buffer> {
  return new CacheEntry([{ id: secretId, secretType: 'tls_server_ca_cert' }], (secrets) => {
    const certs = pemCerts(secrets[0]!.value.toString());
    if (certs.length === 0) {
      throw new InvalidResponseError(`no PEM certificates found in TLS server CA cert secret "${secretId}"`);
    }
    for (const cert of certs) {
      try {
        new X509Certificate(cert);
      } catch (err) {
        throw new InvalidResponseError(
          `invalid PEM certificate in TLS server CA cert secret "${secretId}": ${errorMessage(err)}`
        );
      }
    }
    return Buffer.from(certs.join('\n') + '\n');
  });
}
