import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Connection, ConnectionOptions, TLSConfig } from '@temporalio/client';
import type { Duration } from '@temporalio/common/lib/time';
import { msToNumber } from '@temporalio/common/lib/time';
import type {
  ClientConfigExtension,
  ClientConfigExtensionPlugin,
  ClientConfigExtensionRequest,
  ClientConfigProfile,
} from '@temporalio/envconfig';
import type { NativeConnection, NativeConnectionOptions } from '@temporalio/worker';
import type { CacheEntry, SecretIDs } from './cache';
import { FAILED_REFRESH_RETRY_INTERVAL_MS, hasTLS, SecretCache, SecretFetchError } from './cache';
import type { Fetcher } from './fetch';
import { awsSdkAvailable, awsSdkMissingError, newDefaultFetcher, SDKFetcher } from './fetch';
import { FetchTimeoutError, noopTelemetry, Telemetry } from './telemetry';

/**
 * The name of the extension, which is also its table key under `profile.<profile>.ext`.
 *
 * @experimental The AWS Secrets Manager extension is an experimental feature; APIs may change without notice.
 */
export const EXTENSION_NAME = 'aws_secrets_manager';

const PLUGIN_NAME = '@temporalio/aws-secrets-manager';

const ENV_API_KEY_ID = 'TEMPORAL_EXT_AWS_SECRETS_MANAGER_API_KEY_ID';
const ENV_CLIENT_CERT_ID = 'TEMPORAL_EXT_AWS_SECRETS_MANAGER_TLS_CLIENT_CERT_ID';
const ENV_CLIENT_KEY_ID = 'TEMPORAL_EXT_AWS_SECRETS_MANAGER_TLS_CLIENT_KEY_ID';
const ENV_SERVER_CA_CERT_ID = 'TEMPORAL_EXT_AWS_SECRETS_MANAGER_TLS_SERVER_CA_CERT_ID';

// Same env var and default as the AWS Parameters and Secrets Lambda Extension's cache TTL
const ENV_SECRETS_MANAGER_TTL = 'SECRETS_MANAGER_TTL';
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_STALENESS_MS = 24 * 60 * 60 * 1000;

// Longer timer delays overflow and fire immediately
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Options for {@link SecretsManagerExtension}.
 *
 * @experimental The AWS Secrets Manager extension is an experimental feature; APIs may change without notice.
 */
export interface SecretsManagerExtensionOptions {
  /**
   * Secrets Manager client used to fetch secrets. If unset, secrets are fetched through the AWS
   * Parameters and Secrets Lambda Extension if it is detected, and otherwise with a client created
   * from the default AWS config.
   */
  secretsClient?: SecretsManagerClient;

  /**
   * How long a fetched secret is used before it is refreshed. If unset, defaults to the
   * `SECRETS_MANAGER_TTL` env var (non-negative whole seconds, where 0 refreshes on every use) as
   * used by the AWS Parameters and Secrets Lambda Extension, or 5 minutes if that is unset.
   *
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   */
  refreshInterval?: Duration;

  /**
   * How long after its last successful fetch a secret may still be used if refreshing it fails.
   * Values less than the refresh interval are treated as the refresh interval.
   *
   * @format number of milliseconds or {@link https://www.npmjs.com/package/ms | ms-formatted string}
   * @default 24 hours
   */
  maxStaleness?: Duration;
}

/**
 * Client config extension that loads client credentials from AWS Secrets Manager.
 *
 * Pass to `loadClientConnectConfig` from `@temporalio/envconfig`. See the package README for
 * configuration details.
 *
 * @experimental The AWS Secrets Manager extension is an experimental feature; APIs may change without notice.
 */
export class SecretsManagerExtension implements ClientConfigExtension {
  readonly name = EXTENSION_NAME;

  constructor(private readonly options: SecretsManagerExtensionOptions = {}) {}

  /**
   * Reads secret IDs from the profile and env, and returns a plugin that fetches the configured
   * secrets, or `undefined` if none are configured.
   */
  clientPlugin(request: ClientConfigExtensionRequest): ClientConfigExtensionPlugin | undefined {
    const ids = loadSecretIds(request);
    if (!ids.apiKey && !hasTLS(ids)) {
      return undefined;
    }

    const refreshIntervalMs = this.refreshIntervalMs();
    let maxStalenessMs =
      this.options.maxStaleness !== undefined ? msToNumber(this.options.maxStaleness) : DEFAULT_MAX_STALENESS_MS;
    if (!(maxStalenessMs > 0)) {
      maxStalenessMs = DEFAULT_MAX_STALENESS_MS;
    }
    maxStalenessMs = Math.max(maxStalenessMs, refreshIntervalMs);

    let fetcher: Fetcher;
    if (this.options.secretsClient !== undefined) {
      fetcher = new SDKFetcher(this.options.secretsClient);
    } else {
      fetcher = newDefaultFetcher();
      // Fail fast if the AWS SDK is definitely needed. A DetectingFetcher may not need it, depending
      // on its first-fetch probe, so a missing SDK fails on fetch instead.
      if (fetcher instanceof SDKFetcher && !awsSdkAvailable()) {
        throw awsSdkMissingError();
      }
    }
    return new SecretsManagerPlugin(ids, new SecretCache(fetcher, ids, refreshIntervalMs, maxStalenessMs));
  }

  private refreshIntervalMs(): number {
    if (this.options.refreshInterval !== undefined) {
      const ms = msToNumber(this.options.refreshInterval);
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error('refreshInterval must be a finite, non-negative duration');
      }
      return ms;
    }
    // Read from the process env rather than the config env, like
    // PARAMETERS_SECRETS_EXTENSION_HTTP_PORT, since this is Lambda runtime config shared with the
    // Lambda extension rather than Temporal client config
    const s = process.env[ENV_SECRETS_MANAGER_TTL];
    if (!s) {
      return DEFAULT_REFRESH_INTERVAL_MS;
    }
    const ms = Number(s) * 1000;
    if (!/^[0-9]+$/.test(s) || !Number.isSafeInteger(ms)) {
      throw new Error(`invalid ${ENV_SECRETS_MANAGER_TTL} "${s}", must be a non-negative whole number of seconds`);
    }
    return ms;
  }
}

function loadSecretIds(request: ClientConfigExtensionRequest): SecretIDs {
  const ids: SecretIDs = { apiKey: '', clientCert: '', clientKey: '', serverCACert: '' };
  applyToml(ids, request.profile.ext?.[EXTENSION_NAME] ?? {});
  const env = request.env;
  if (env !== undefined) {
    // Like envconfig, set-but-empty env vars override (and so can unset) file values
    for (const [name, field] of [
      [ENV_API_KEY_ID, 'apiKey'],
      [ENV_CLIENT_CERT_ID, 'clientCert'],
      [ENV_CLIENT_KEY_ID, 'clientKey'],
      [ENV_SERVER_CA_CERT_ID, 'serverCACert'],
    ] as const) {
      const value = env[name];
      if (value !== undefined) {
        ids[field] = value;
      }
    }
  }
  validate(ids, request.profile);
  return ids;
}

function applyToml(ids: SecretIDs, table: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(table)) {
    if (key === 'api_key_id') {
      ids.apiKey = tomlString(key, value);
    } else if (key === 'tls') {
      if (!isTable(value)) {
        throw new Error(`ext.${EXTENSION_NAME}.tls must be a table, got ${typeName(value)}`);
      }
      for (const [tlsKey, tlsValue] of Object.entries(value)) {
        if (tlsKey === 'client_cert_id') {
          ids.clientCert = tomlString(`tls.${tlsKey}`, tlsValue);
        } else if (tlsKey === 'client_key_id') {
          ids.clientKey = tomlString(`tls.${tlsKey}`, tlsValue);
        } else if (tlsKey === 'server_ca_cert_id') {
          ids.serverCACert = tomlString(`tls.${tlsKey}`, tlsValue);
        } else {
          throw new Error(`unknown key "${tlsKey}" in ext.${EXTENSION_NAME}.tls`);
        }
      }
    } else {
      throw new Error(`unknown key "${key}" in ext.${EXTENSION_NAME}`);
    }
  }
}

function isTable(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  return typeof value;
}

function tomlString(key: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`ext.${EXTENSION_NAME}.${key} must be a string, got ${typeName(value)}`);
  }
  return value;
}

function validate(ids: SecretIDs, profile: ClientConfigProfile): void {
  const conflicts: string[] = [];
  if (ids.apiKey && profile.apiKey) {
    conflicts.push('API key secret ID cannot be set with an API key');
  }
  const tls = profile.tls;
  if (tls !== undefined) {
    if (ids.clientCert && tls.clientCert) {
      conflicts.push('TLS client cert secret ID cannot be set with client cert path or data');
    }
    if (ids.clientKey && tls.clientKey) {
      conflicts.push('TLS client key secret ID cannot be set with client key path or data');
    }
    if (ids.serverCACert && tls.serverCACert) {
      conflicts.push('TLS server CA cert secret ID cannot be set with server CA cert path or data');
    }
    if (hasTLS(ids) && tls.disabled) {
      conflicts.push('TLS secret IDs cannot be set when TLS is disabled');
    }
  }
  if (!!ids.clientCert !== !!ids.clientKey) {
    conflicts.push('TLS client cert and key secret IDs must be set together');
  }
  if (conflicts.length > 0) {
    throw new Error(`invalid config: ${conflicts.sort().join('; ')}`);
  }
}

type ConnectionLikeOptions = Pick<ConnectionOptions | NativeConnectionOptions, 'apiKey' | 'tls'>;

/**
 * Fetches secrets when connecting, with `Connection.connect` or `NativeConnection.connect`.
 * `Connection.lazy` isn't supported, since it can't wait for secrets to be fetched.
 */
class SecretsManagerPlugin implements ClientConfigExtensionPlugin {
  readonly name = PLUGIN_NAME;
  /**
   * The API key is refreshed at most this often, and retried this long after a failed refresh.
   * Checking more often would only be cache hits, and with a refresh interval of 0 (no caching), this
   * bounds the fetch rate. Overridable in tests.
   */
  minRefreshIntervalMs = FAILED_REFRESH_RETRY_INTERVAL_MS;

  constructor(
    private readonly ids: SecretIDs,
    private readonly cache: SecretCache
  ) {}

  async connect(
    options: ConnectionOptions,
    next: (options: ConnectionOptions) => Promise<Connection>
  ): Promise<Connection> {
    // Connection (unlike NativeConnection) has no runtime to report to
    const tel = noopTelemetry;
    const resolved = await this.resolve(options, tel);
    const entry = this.cache.apiKey;
    if (entry !== undefined) {
      // Connection calls this before each request. It returns the cached key right away, and starts
      // fetching it again in the background when due, so a rotated key is picked up without
      // reconnecting, and requests never wait on Secrets Manager. If the key is older than the max
      // staleness and refreshing it fails, an empty key sends no Authorization header, so requests
      // fail until a refresh succeeds instead of using the stale key indefinitely.
      resolved.apiKey = () => this.cache.getNow(entry, this.minRefreshIntervalMs, tel) ?? '';
    }
    return next({ ...options, ...resolved } as ConnectionOptions);
  }

  async connectNative(
    options: NativeConnectionOptions,
    next: (options: NativeConnectionOptions) => Promise<NativeConnection>
  ): Promise<NativeConnection> {
    // Already loaded, since it's calling this hook
    const { Runtime } = await import('@temporalio/worker');
    const runtime = Runtime.instance();
    const tel = new Telemetry(runtime.metricMeter, runtime.logger);
    const resolved = await this.resolve(options, tel);
    const conn = await next({ ...options, ...resolved } as NativeConnectionOptions);
    if (this.cache.apiKey !== undefined && typeof resolved.apiKey === 'string') {
      this.refreshAPIKey(new WeakRef(conn), this.cache.apiKey, resolved.apiKey, tel);
    }
    return conn;
  }

  /** Fetches the configured secrets and returns the connection options they replace. */
  private async resolve(
    options: ConnectionLikeOptions,
    tel: Telemetry
  ): Promise<{ apiKey?: string | (() => string); tls?: TLSConfig }> {
    const resolved: { apiKey?: string | (() => string); tls?: TLSConfig } = {};

    if (this.cache.apiKey !== undefined) {
      if (options.apiKey !== undefined) {
        throw new Error('cannot use API key from AWS Secrets Manager, API key already set');
      }
      // Like an API key from envconfig, this enables TLS unless it's explicitly configured
      resolved.apiKey = await this.cache.get(this.cache.apiKey, tel);
    }

    if (hasTLS(this.ids)) {
      if (options.tls === false) {
        throw new Error('cannot use TLS config from AWS Secrets Manager, TLS is disabled');
      }
      const tls: TLSConfig = typeof options.tls === 'object' && options.tls !== null ? { ...options.tls } : {};
      if (this.cache.clientCert !== undefined) {
        if (tls.clientCertPair !== undefined) {
          throw new Error('cannot use TLS client cert from AWS Secrets Manager, client certificates already set');
        }
        tls.clientCertPair = await this.cache.get(this.cache.clientCert, tel);
      }
      if (this.cache.serverCACert !== undefined) {
        if (tls.serverRootCACertificate !== undefined) {
          throw new Error('cannot use TLS server CA cert from AWS Secrets Manager, server root CA cert already set');
        }
        tls.serverRootCACertificate = await this.cache.get(this.cache.serverCACert, tel);
      }
      resolved.tls = tls;
    }
    return resolved;
  }

  /**
   * Keeps a native connection's API key up to date until it's closed or garbage collected.
   * `NativeConnection` only takes a static API key, so it's pushed to the connection when refreshed.
   */
  private refreshAPIKey(ref: WeakRef<NativeConnection>, entry: CacheEntry<string>, initialKey: string, tel: Telemetry) {
    const intervalMs = Math.max(this.cache.refreshIntervalMs, this.minRefreshIntervalMs);
    // Undefined while removed
    let apiKey: string | undefined = initialKey;

    // Returns false if the connection is gone or closed. Not held across awaits, so that the
    // connection can be collected. NativeConnection can't unset its key, so a removed key is set
    // to an empty one, which isn't a usable credential.
    const setAPIKey = async (key: string | undefined): Promise<boolean> => {
      const conn = ref.deref();
      if (conn === undefined) {
        return false;
      }
      try {
        await conn.setApiKey(key ?? '');
        return true;
      } catch {
        return false;
      }
    };

    const schedule = () => {
      // Retry sooner if the last refresh failed or the key was removed
      const delayMs = entry.failedAt !== undefined || apiKey === undefined ? this.minRefreshIntervalMs : intervalMs;
      // Unref'd so that it doesn't keep the process alive
      setTimeout(() => void tick(), Math.min(delayMs, MAX_TIMER_DELAY_MS)).unref();
    };

    // Returns whether to keep refreshing
    const refresh = async (): Promise<boolean> => {
      // Setting the current key detects a closed connection before fetching for it
      if (!(await setAPIKey(apiKey))) {
        return false;
      }
      let newKey: string | undefined;
      let error: unknown;
      try {
        newKey = await this.cache.get(entry, tel);
      } catch (err) {
        // Expected failures are already counted by the cache, and are only thrown when there's no
        // value within the max staleness, so stop using the current key instead of using it
        // indefinitely. Calls fail until a refresh succeeds. Anything else is a bug, but is still
        // treated as having no usable key, rather than letting refreshing stop and keep the current
        // key forever.
        if (!(err instanceof SecretFetchError || err instanceof FetchTimeoutError)) {
          tel.record(() =>
            tel.logger?.error('Unexpected error refreshing client API key from AWS Secrets Manager', {
              error: err,
            })
          );
        }
        newKey = undefined;
        error = err;
      }
      if (newKey === apiKey) {
        return true;
      }
      if (!(await setAPIKey(newKey))) {
        return false;
      }
      apiKey = newKey;
      if (newKey === undefined) {
        tel.record(() =>
          tel.logger?.warn('Removed client API key, no AWS Secrets Manager value within max staleness', {
            maxStalenessMs: this.cache.maxStalenessMs,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      } else {
        tel.record(() => tel.logger?.debug('Updated client API key from AWS Secrets Manager'));
      }
      return true;
    };

    const tick = async () => {
      let keepRefreshing: boolean;
      try {
        keepRefreshing = await refresh();
      } catch (err) {
        // Shouldn't happen, but keep refreshing rather than stop silently or reject unhandled
        tel.record(() =>
          tel.logger?.error('Unexpected error refreshing client API key from AWS Secrets Manager', { error: err })
        );
        keepRefreshing = true;
      }
      if (keepRefreshing) {
        schedule();
      }
    };

    schedule();
  }
}
