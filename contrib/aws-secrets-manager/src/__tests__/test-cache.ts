import test from 'ava';
import type { SecretIDs } from '../cache';
import { FAILED_REFRESH_RETRY_INTERVAL_MS, SecretCache, SecretFetchError } from '../cache';
import { InvalidResponseError } from '../telemetry';
import {
  TEST_CERT_A,
  TEST_CERT_B,
  FakeFetcher,
  Gate,
  TEST_KEY_A,
  TEST_KEY_A_EC,
  TEST_KEY_B,
  Recorder,
  waitUntil,
} from './helpers';

const REFRESH_MS = 60_000;
const MAX_STALENESS_MS = 3_600_000;

function ids(overrides: Partial<SecretIDs>): SecretIDs {
  return { apiKey: '', clientCert: '', clientKey: '', serverCACert: '', ...overrides };
}

function newCache(
  fetcher: FakeFetcher,
  secretIds: Partial<SecretIDs> = { apiKey: 'key' },
  refreshMs = REFRESH_MS
): { cache: SecretCache; clock: { now: number } } {
  const cache = new SecretCache(fetcher, ids(secretIds), refreshMs, MAX_STALENESS_MS);
  const clock = { now: 1_000_000 };
  cache.now = () => clock.now;
  return { cache, clock };
}

test('hit, miss and rotation', async (t) => {
  const fetcher = new FakeFetcher();
  fetcher.set('key', 'v1', 'ver1');
  const { cache, clock } = newCache(fetcher);
  const rec = new Recorder();
  const entry = cache.apiKey!;

  t.is(await cache.get(entry, rec.telemetry), 'v1');
  t.is(await cache.get(entry, rec.telemetry), 'v1');
  t.is(fetcher.calls.get('key'), 1);
  t.deepEqual(rec.take('temporal_aws_secrets_manager_cache_lookup'), [
    { secret_type: 'api_key', fetch_path: 'sdk', result: 'miss' },
    { secret_type: 'api_key', fetch_path: 'sdk', result: 'hit' },
  ]);
  t.deepEqual(rec.take('temporal_aws_secrets_manager_fetch_latency'), [
    { secret_type: 'api_key', fetch_path: 'sdk', outcome: 'success' },
  ]);
  t.deepEqual(
    rec.logs.map((l) => [l.message, l.meta]),
    [
      [
        'Fetched AWS Secrets Manager secret',
        { secretId: 'key', secretType: 'api_key', fetchPath: 'sdk', versionId: 'ver1' },
      ],
    ]
  );

  // Unchanged after the refresh interval, so no update is logged
  clock.now += REFRESH_MS;
  t.is(await cache.get(entry, rec.telemetry), 'v1');
  t.is(fetcher.calls.get('key'), 2);
  t.is(rec.logs.length, 1);

  // Rotated
  fetcher.set('key', 'v2', 'ver2');
  clock.now += REFRESH_MS;
  t.is(await cache.get(entry, rec.telemetry), 'v2');
  t.deepEqual(rec.logs[1]?.meta, {
    secretId: 'key',
    secretType: 'api_key',
    previousVersionId: 'ver1',
    versionId: 'ver2',
  });
});

test('zero refresh interval always fetches', async (t) => {
  const fetcher = new FakeFetcher();
  fetcher.set('key', 'v1', 'ver1');
  const { cache } = newCache(fetcher, { apiKey: 'key' }, 0);
  const rec = new Recorder();
  await cache.get(cache.apiKey!, rec.telemetry);
  await cache.get(cache.apiKey!, rec.telemetry);
  t.is(fetcher.calls.get('key'), 2);
});

test('failure falls back to stale value and waits before retrying', async (t) => {
  const fetcher = new FakeFetcher();
  fetcher.set('key', 'v1', 'ver1');
  const { cache, clock } = newCache(fetcher);
  const rec = new Recorder();
  const entry = cache.apiKey!;
  await cache.get(entry, rec.telemetry);
  rec.take('temporal_aws_secrets_manager_cache_lookup');

  const err = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
  fetcher.fail('key', err);
  clock.now += REFRESH_MS;
  t.is(await cache.get(entry, rec.telemetry), 'v1');
  t.deepEqual(rec.take('temporal_aws_secrets_manager_fetch_failed'), [
    { secret_type: 'api_key', fetch_path: 'sdk', failure_reason: 'access_denied', fallback: 'stale' },
  ]);
  t.deepEqual(rec.take('temporal_aws_secrets_manager_fetch_latency').at(-1), {
    secret_type: 'api_key',
    fetch_path: 'sdk',
    outcome: 'failure',
  });
  const warning = rec.logs.find((l) => l.level === 'WARN');
  t.is(warning?.message, 'Failed refreshing AWS Secrets Manager secret, using previously fetched value');
  t.like(warning?.meta, { secretId: 'key', secretType: 'api_key', ageMs: REFRESH_MS });

  // Not retried until the retry interval has passed
  clock.now += FAILED_REFRESH_RETRY_INTERVAL_MS - 1;
  t.is(await cache.get(entry, rec.telemetry), 'v1');
  t.is(fetcher.calls.get('key'), 2);
  clock.now += 1;
  t.is(await cache.get(entry, rec.telemetry), 'v1');
  t.is(fetcher.calls.get('key'), 3);
  t.deepEqual(
    rec.take('temporal_aws_secrets_manager_cache_lookup').map((tags) => tags.result),
    ['miss_with_fallback', 'miss_with_fallback', 'miss_with_fallback']
  );

  // Recovery is logged even though the version didn't change
  fetcher.set('key', 'v1', 'ver1');
  clock.now += FAILED_REFRESH_RETRY_INTERVAL_MS;
  t.is(await cache.get(entry, rec.telemetry), 'v1');
  t.is(rec.logs.at(-1)?.message, 'Fetched updated AWS Secrets Manager secret');
  t.is(entry.failedAt, undefined);
});

test('failure without a previous value throws', async (t) => {
  const fetcher = new FakeFetcher();
  fetcher.fail('key', Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' }));
  const { cache } = newCache(fetcher);
  const rec = new Recorder();
  const err = await t.throwsAsync(cache.get(cache.apiKey!, rec.telemetry), { instanceOf: SecretFetchError });
  t.is(err?.message, 'failed fetching AWS Secrets Manager secret "key": nope');
  t.is(err?.reason, 'resource_not_found');
  t.deepEqual(rec.take('temporal_aws_secrets_manager_fetch_failed'), [
    { secret_type: 'api_key', fetch_path: 'sdk', failure_reason: 'resource_not_found', fallback: 'none' },
  ]);
  t.deepEqual(rec.take('temporal_aws_secrets_manager_cache_lookup'), []);
});

test('stale value is not used past max staleness', async (t) => {
  const fetcher = new FakeFetcher();
  fetcher.set('key', 'v1', 'ver1');
  const { cache, clock } = newCache(fetcher);
  const rec = new Recorder();
  await cache.get(cache.apiKey!, rec.telemetry);
  fetcher.fail('key', new Error('down'));
  clock.now += MAX_STALENESS_MS;
  await t.throwsAsync(cache.get(cache.apiKey!, rec.telemetry), { instanceOf: SecretFetchError });
});

test('concurrent gets share a fetch', async (t) => {
  const fetcher = new FakeFetcher();
  fetcher.set('key', 'v1', 'ver1');
  fetcher.gate = new Gate();
  const { cache } = newCache(fetcher);
  const rec = new Recorder();
  const gets = [cache.get(cache.apiKey!, rec.telemetry), cache.get(cache.apiKey!, rec.telemetry)];
  fetcher.gate.open();
  t.deepEqual(await Promise.all(gets), ['v1', 'v1']);
  t.is(fetcher.calls.get('key'), 1);
});

test('refreshing serves the stale value to other callers', async (t) => {
  const fetcher = new FakeFetcher();
  fetcher.set('key', 'v1', 'ver1');
  const { cache, clock } = newCache(fetcher);
  const rec = new Recorder();
  await cache.get(cache.apiKey!, rec.telemetry);

  fetcher.set('key', 'v2', 'ver2');
  fetcher.gate = new Gate();
  clock.now += REFRESH_MS;
  const refreshing = cache.get(cache.apiKey!, rec.telemetry);
  t.is(await cache.get(cache.apiKey!, rec.telemetry), 'v1');
  fetcher.gate.open();
  t.is(await refreshing, 'v2');
});

test('a caller timing out does not cancel the fetch', async (t) => {
  const fetcher = new FakeFetcher();
  fetcher.set('key', 'v1', 'ver1');
  fetcher.gate = new Gate();
  const { cache } = newCache(fetcher);
  cache.fetchTimeoutMs = 10;
  const rec = new Recorder();
  await t.throwsAsync(cache.get(cache.apiKey!, rec.telemetry), {
    message: 'timed out after 10ms waiting for AWS Secrets Manager secret fetch',
  });

  // The fetch completes and is cached for the next caller
  fetcher.gate.open();
  await waitUntil(() => cache.apiKey!.inFlight === undefined);
  t.is(await cache.get(cache.apiKey!, rec.telemetry), 'v1');
  t.is(fetcher.calls.get('key'), 1);
});

test('a fetch that fails after its caller timed out is not an unhandled rejection', async (t) => {
  const fetcher = new FakeFetcher();
  fetcher.fail('key', new Error('down'));
  fetcher.gate = new Gate();
  const { cache } = newCache(fetcher);
  cache.fetchTimeoutMs = 10;
  const rec = new Recorder();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await t.throwsAsync(cache.get(cache.apiKey!, rec.telemetry));
    fetcher.gate.open();
    await waitUntil(() => cache.apiKey!.inFlight === undefined);
    // Unhandled rejections are reported after a macrotask
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  t.deepEqual(unhandled, []);
});

test('timed out wait falls back to stale value', async (t) => {
  const fetcher = new FakeFetcher();
  fetcher.set('key', 'v1', 'ver1');
  const { cache, clock } = newCache(fetcher, { apiKey: 'key' }, 0);
  const rec = new Recorder();
  await cache.get(cache.apiKey!, rec.telemetry);

  fetcher.gate = new Gate();
  cache.fetchTimeoutMs = 10;
  clock.now += 1;
  t.is(await cache.get(cache.apiKey!, rec.telemetry), 'v1');
  t.is(rec.take('temporal_aws_secrets_manager_cache_lookup').at(-1)?.result, 'miss_with_fallback');
  fetcher.gate.open();
  await waitUntil(() => cache.apiKey!.inFlight === undefined);
});

test('getNow returns the current value and refreshes in the background when due', async (t) => {
  const fetcher = new FakeFetcher();
  fetcher.set('key', 'v1', 'ver1');
  const { cache, clock } = newCache(fetcher, { apiKey: 'key' }, 0);
  const rec = new Recorder();
  const entry = cache.apiKey!;
  await cache.get(entry, rec.telemetry);

  // A zero refresh interval is bounded by the minimum
  fetcher.set('key', 'v2', 'ver2');
  t.is(cache.getNow(entry, 1000, rec.telemetry), 'v1');
  t.is(entry.inFlight, undefined);
  clock.now += 1000;
  t.is(cache.getNow(entry, 1000, rec.telemetry), 'v1');
  t.not(entry.inFlight, undefined);
  await waitUntil(() => entry.inFlight === undefined);
  t.is(cache.getNow(entry, 1000, rec.telemetry), 'v2');

  // A failed refresh keeps the current value up to the max staleness, and isn't retried until the
  // retry interval has passed
  fetcher.fail('key', new Error('down'));
  clock.now += 2000;
  t.is(cache.getNow(entry, 1000, rec.telemetry), 'v2');
  await waitUntil(() => entry.inFlight === undefined);
  t.is(cache.getNow(entry, 1000, rec.telemetry), 'v2');
  t.is(entry.inFlight, undefined);

  // Past the max staleness, the value is kept until a refresh started after then fails, after which
  // there's no value, but refreshing continues
  clock.now += MAX_STALENESS_MS;
  t.is(cache.getNow(entry, 1000, rec.telemetry), 'v2');
  t.not(entry.inFlight, undefined);
  await waitUntil(() => entry.inFlight === undefined);
  t.is(cache.getNow(entry, 1000, rec.telemetry), undefined);
  t.is(entry.inFlight, undefined);
  fetcher.set('key', 'v3', 'ver3');
  clock.now += FAILED_REFRESH_RETRY_INTERVAL_MS;
  t.is(cache.getNow(entry, 1000, rec.telemetry), undefined);
  t.not(entry.inFlight, undefined);
  await waitUntil(() => entry.inFlight === undefined);
  t.is(cache.getNow(entry, 1000, rec.telemetry), 'v3');

  // A value that wasn't looked up for longer than the max staleness is kept while it's refreshed
  fetcher.set('key', 'v4', 'ver4');
  clock.now += MAX_STALENESS_MS;
  t.is(cache.getNow(entry, 1000, rec.telemetry), 'v3');
  t.not(entry.inFlight, undefined);
  await waitUntil(() => entry.inFlight === undefined);
  t.is(cache.getNow(entry, 1000, rec.telemetry), 'v4');
});

test('bundled client cert and key', async (t) => {
  const fetcher = new FakeFetcher();
  fetcher.set('bundle', `junk\n${TEST_CERT_A}${TEST_KEY_A}`, 'ver1');
  const { cache } = newCache(fetcher, { clientCert: 'bundle', clientKey: 'bundle' });
  const pair = await cache.get(cache.clientCert!, new Recorder().telemetry);
  t.is(pair.crt.toString(), TEST_CERT_A);
  t.is(pair.key.toString(), TEST_KEY_A);
  t.is(fetcher.calls.get('bundle'), 1);
});

test('separate client cert and key', async (t) => {
  const fetcher = new FakeFetcher();
  fetcher.set('cert', TEST_CERT_A, 'ver1');
  fetcher.set('key', TEST_KEY_A_EC, 'ver2');
  const { cache } = newCache(fetcher, { clientCert: 'cert', clientKey: 'key' });
  const rec = new Recorder();
  const pair = await cache.get(cache.clientCert!, rec.telemetry);
  t.is(pair.crt.toString(), TEST_CERT_A);
  t.is(pair.key.toString(), TEST_KEY_A_EC);
  // Both are reported as the client cert in metrics, and logged separately
  t.deepEqual(rec.take('temporal_aws_secrets_manager_cache_lookup'), [
    { secret_type: 'tls_client_cert', fetch_path: 'sdk', result: 'miss' },
  ]);
  t.deepEqual(
    rec.logs.map((l) => l.meta?.secretType),
    ['tls_client_cert', 'tls_client_key']
  );
});

test('mismatched client cert and key keep the previous pair', async (t) => {
  const fetcher = new FakeFetcher();
  fetcher.set('cert', TEST_CERT_A, 'ver1');
  fetcher.set('key', TEST_KEY_A, 'ver1');
  const { cache, clock } = newCache(fetcher, { clientCert: 'cert', clientKey: 'key' });
  const rec = new Recorder();
  await cache.get(cache.clientCert!, rec.telemetry);

  // Fetched partway through rotating the separate secrets
  fetcher.set('cert', TEST_CERT_B, 'ver2');
  clock.now += REFRESH_MS;
  const pair = await cache.get(cache.clientCert!, rec.telemetry);
  t.is(pair.crt.toString(), TEST_CERT_A);
  t.deepEqual(rec.take('temporal_aws_secrets_manager_fetch_failed'), [
    { secret_type: 'tls_client_cert', fetch_path: 'sdk', failure_reason: 'invalid_response', fallback: 'stale' },
  ]);

  fetcher.set('key', TEST_KEY_B, 'ver2');
  clock.now += FAILED_REFRESH_RETRY_INTERVAL_MS;
  t.is((await cache.get(cache.clientCert!, rec.telemetry)).crt.toString(), TEST_CERT_B);
});

for (const [name, cert, key, message] of [
  ['no cert', TEST_KEY_A, TEST_KEY_A, 'no PEM certificate found in TLS client cert secret "cert"'],
  ['no key', TEST_CERT_A, TEST_CERT_A, 'no PEM private key found in TLS client key secret "key"'],
  [
    'mismatched',
    TEST_CERT_A,
    TEST_KEY_B,
    `TLS client cert and key from AWS Secrets Manager secrets "cert" and "key" don't match`,
  ],
  [
    'unparseable',
    '-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----',
    TEST_KEY_A,
    /^failed loading TLS client cert\/key from AWS Secrets Manager secrets "cert" and "key": /,
  ],
] as const) {
  test(`invalid client cert and key: ${name}`, async (t) => {
    const fetcher = new FakeFetcher();
    fetcher.set('cert', cert, 'ver1');
    fetcher.set('key', key, 'ver1');
    const { cache } = newCache(fetcher, { clientCert: 'cert', clientKey: 'key' });
    const err = await t.throwsAsync(cache.get(cache.clientCert!, new Recorder().telemetry), {
      instanceOf: SecretFetchError,
      message,
    });
    t.is(err?.reason, 'invalid_response');
    t.true(err?.cause instanceof InvalidResponseError);
  });
}

test('invalid UTF-8 API key', async (t) => {
  const fetcher = new FakeFetcher();
  fetcher.set('key', Buffer.from([0xff, 0xfe]), 'ver1');
  const { cache } = newCache(fetcher);
  const err = await t.throwsAsync(cache.get(cache.apiKey!, new Recorder().telemetry), {
    instanceOf: SecretFetchError,
    message: 'API key secret is not valid UTF-8',
  });
  t.is(err?.reason, 'invalid_response');
});

test('server CA cert', async (t) => {
  const fetcher = new FakeFetcher();
  fetcher.set('ca', `${TEST_CERT_A}\n${TEST_CERT_B}`, 'ver1');
  const { cache } = newCache(fetcher, { serverCACert: 'ca' });
  t.is((await cache.get(cache.serverCACert!, new Recorder().telemetry)).toString(), `${TEST_CERT_A}${TEST_CERT_B}`);

  fetcher.set('ca2', 'nothing here', 'ver1');
  const { cache: cache2 } = newCache(fetcher, { serverCACert: 'ca2' });
  await t.throwsAsync(cache2.get(cache2.serverCACert!, new Recorder().telemetry), {
    message: 'no PEM certificates found in TLS server CA cert secret "ca2"',
  });
});
