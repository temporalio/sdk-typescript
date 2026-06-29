import type { IdGenerator } from '@opentelemetry/sdk-trace-base';
import { getRandomStream } from './workflow-imports';

const OTEL_ID_RANDOM_STREAM = '@temporalio/interceptors-opentelemetry-v2/id-generator';

function randomHex(length: number): string {
  const stream = getRandomStream(OTEL_ID_RANDOM_STREAM);
  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    const nibble = (stream.random() * 16) >>> 0;
    chars.push(nibble.toString(16));
  }
  return chars.join('');
}

/**
 * Generates span and trace IDs from a named workflow random stream.
 */
export class DeterministicIdGenerator implements IdGenerator {
  generateTraceId(): string {
    const id = randomHex(32);
    // Ensure non-zero per W3C Trace Context spec
    return id === '00000000000000000000000000000000' ? '00000000000000000000000000000001' : id;
  }

  generateSpanId(): string {
    const id = randomHex(16);
    return id === '0000000000000000' ? '0000000000000001' : id;
  }
}
