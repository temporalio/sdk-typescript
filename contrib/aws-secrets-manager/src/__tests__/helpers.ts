import type {
  Logger,
  LogLevel,
  LogMetadata,
  MetricCounter,
  MetricHistogram,
  MetricMeter,
  MetricTags,
} from '@temporalio/common';
import type { Fetcher, SecretValue } from '../fetch';
import type { FetchPath } from '../telemetry';
import { Telemetry } from '../telemetry';

// Self-signed EC test certs, generated just for this module's tests and
// deliberately expired so they can't be used as real credentials.
// They're only parsed and matched against their keys, never used for TLS.
// TEST_KEY_A_EC is TEST_KEY_A in the traditional EC format.
export const TEST_CERT_A = `-----BEGIN CERTIFICATE-----
MIIBnjCCAUWgAwIBAgIUDqZuJ4EivyOw4rVmjlePA7udGhUwCgYIKoZIzj0EAwIw
JTEjMCEGA1UEAwwaYXdzLXNlY3JldHMtbWFuYWdlci10ZXN0LWEwHhcNMDAwMTAx
MDAwMDAwWhcNMDAwMTAyMDAwMDAwWjAlMSMwIQYDVQQDDBphd3Mtc2VjcmV0cy1t
YW5hZ2VyLXRlc3QtYTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABPYjw38P+CZ7
5Gn5L4yZ7QfLq1MNax7wuqmksAu+SSwNwmjiNBM0LpvEHZGaB5uun4JVwPDX2Caw
dOzRMMjkJfGjUzBRMB0GA1UdDgQWBBQqh6LjSKZlTFBKw8fPrKcMppVc0TAfBgNV
HSMEGDAWgBQqh6LjSKZlTFBKw8fPrKcMppVc0TAPBgNVHRMBAf8EBTADAQH/MAoG
CCqGSM49BAMCA0cAMEQCIBOvMndUhN/E4pi3ohOrZhZ98yUG+5wGkPirzSgiyrGA
AiB67ITqPqGBwT1mOTKnHa0R801etROwSp8EicjU65Xi0A==
-----END CERTIFICATE-----
`;
export const TEST_KEY_A = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQguBxMHVTJpKDUQdXp
lUqPRKgtTMRVEVjYJbRybzKMYoehRANCAAT2I8N/D/gme+Rp+S+Mme0Hy6tTDWse
8LqppLALvkksDcJo4jQTNC6bxB2Rmgebrp+CVcDw19gmsHTs0TDI5CXx
-----END PRIVATE KEY-----
`;
export const TEST_KEY_A_EC = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEILgcTB1UyaSg1EHV6ZVKj0SoLUzEVRFY2CW0cm8yjGKHoAoGCCqGSM49
AwEHoUQDQgAE9iPDfw/4JnvkafkvjJntB8urUw1rHvC6qaSwC75JLA3CaOI0EzQu
m8QdkZoHm66fglXA8NfYJrB07NEwyOQl8Q==
-----END EC PRIVATE KEY-----
`;
export const TEST_CERT_B = `-----BEGIN CERTIFICATE-----
MIIBoDCCAUWgAwIBAgIUJkXwBu3Peti5+WEGvCfk3YQYnFgwCgYIKoZIzj0EAwIw
JTEjMCEGA1UEAwwaYXdzLXNlY3JldHMtbWFuYWdlci10ZXN0LWIwHhcNMDAwMTAx
MDAwMDAwWhcNMDAwMTAyMDAwMDAwWjAlMSMwIQYDVQQDDBphd3Mtc2VjcmV0cy1t
YW5hZ2VyLXRlc3QtYjBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABFeVEzhEhUbs
l4sgc8vkm5Lfgemqc5h2EirK5OAna/9/Yd4feUw8JYK6VKfIeJJBVeaKjJbihaTY
aXA9zg+PBMCjUzBRMB0GA1UdDgQWBBTBGCIL3D2zvsou4vFsR2lsmwTtdjAfBgNV
HSMEGDAWgBTBGCIL3D2zvsou4vFsR2lsmwTtdjAPBgNVHRMBAf8EBTADAQH/MAoG
CCqGSM49BAMCA0kAMEYCIQDnP+D+kffMeiRoerQaNplgBlaH++eFY+MPLKMLMuRc
UAIhAKcdRK2djsmk2QP7q7yc1js9HeDONluoo2WaWLMilAyk
-----END CERTIFICATE-----
`;
export const TEST_KEY_B = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsjA2Q9nct3Mb+KOR
akioJrOmqRw6/SzLSucTqopek9qhRANCAARXlRM4RIVG7JeLIHPL5JuS34HpqnOY
dhIqyuTgJ2v/f2HeH3lMPCWCulSnyHiSQVXmioyW4oWk2GlwPc4PjwTA
-----END PRIVATE KEY-----
`;

/** Polls until `cond` is true, failing if it isn't within `timeoutMs`. */
export async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A promise that can be resolved externally. */
export class Gate {
  readonly promise: Promise<void>;
  open!: () => void;

  constructor() {
    this.promise = new Promise((resolve) => (this.open = resolve));
  }
}

/**
 * Returns configured values, counting fetches. A value may be an error to throw. If `gate` is set,
 * fetches wait for it.
 */
export class FakeFetcher implements Fetcher {
  values = new Map<string, SecretValue | Error>();
  calls = new Map<string, number>();
  gate?: Gate;

  constructor(readonly path: FetchPath = 'sdk') {}

  set(secretId: string, value: string | Buffer, versionId: string): void {
    this.values.set(secretId, { value: Buffer.from(value), versionId });
  }

  fail(secretId: string, err: Error): void {
    this.values.set(secretId, err);
  }

  async fetch(secretId: string): Promise<SecretValue> {
    this.calls.set(secretId, (this.calls.get(secretId) ?? 0) + 1);
    await this.gate?.promise;
    const value = this.values.get(secretId);
    if (value === undefined) {
      throw new Error(`no fake value for ${secretId}`);
    }
    if (value instanceof Error) {
      throw value;
    }
    return value;
  }
}

export interface MetricUpdate {
  name: string;
  value: number;
  tags: MetricTags;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  meta?: LogMetadata;
}

/** Telemetry that records metric updates and logs. */
export class Recorder {
  readonly updates: MetricUpdate[] = [];
  readonly logs: LogEntry[] = [];
  readonly telemetry: Telemetry;

  constructor() {
    const updates = this.updates;
    const metric = (name: string) =>
      ({
        name,
        kind: 'counter',
        valueType: 'int',
        add: (value: number, tags?: MetricTags) => updates.push({ name, value, tags: tags ?? {} }),
        record: (value: number, tags?: MetricTags) => updates.push({ name, value, tags: tags ?? {} }),
      }) as unknown as MetricCounter & MetricHistogram;
    const meter = {
      createCounter: metric,
      createHistogram: metric,
      withTags: () => meter,
    } as unknown as MetricMeter;
    this.telemetry = new Telemetry(meter, recordingLogger(this.logs));
  }

  /** Returns and clears the tags of each update of the given metric. */
  take(name: string): MetricTags[] {
    const taken = this.updates.filter((u) => u.name === name).map((u) => u.tags);
    const rest = this.updates.filter((u) => u.name !== name);
    this.updates.splice(0, this.updates.length, ...rest);
    return taken;
  }
}

export function recordingLogger(logs: LogEntry[]): Logger {
  const log = (level: LogLevel) => (message: string, meta?: LogMetadata) => {
    logs.push({ level, message, meta });
  };
  return {
    log: (level, message, meta) => {
      logs.push({ level, message, meta });
    },
    trace: log('TRACE'),
    debug: log('DEBUG'),
    info: log('INFO'),
    warn: log('WARN'),
    error: log('ERROR'),
  };
}
