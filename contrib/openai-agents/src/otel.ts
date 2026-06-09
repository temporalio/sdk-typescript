import { BasicTracerProvider, type IdGenerator, type TracerConfig } from '@opentelemetry/sdk-trace-base';
import { isReplaySafeTracerProvider, markReplaySafeTracerProvider } from './common/tracing-bridge';
import { seedsStorage } from './worker/seeded-ids';

export { isReplaySafeTracerProvider, markReplaySafeTracerProvider };

function randomHex(len: number): string {
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** OTel `IdGenerator` that yields a seeded ID when called inside `withSeededIds`. */
export class TemporalIdGenerator implements IdGenerator {
  generateTraceId(): string {
    return seedsStorage.getStore()?.trace ?? randomHex(32);
  }
  generateSpanId(): string {
    return seedsStorage.getStore()?.span ?? randomHex(16);
  }
}

export type TemporalOpenAIAgentsTracerProviderOptions = Omit<TracerConfig, 'idGenerator'>;

export function createTracerProvider(options?: TemporalOpenAIAgentsTracerProviderOptions): BasicTracerProvider {
  const provider = new BasicTracerProvider({ ...options, idGenerator: new TemporalIdGenerator() });
  return markReplaySafeTracerProvider(provider);
}
