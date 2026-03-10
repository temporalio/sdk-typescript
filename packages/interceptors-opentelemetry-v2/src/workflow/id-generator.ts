import type { IdGenerator } from '@opentelemetry/sdk-trace-base';
import { alea, type RNG } from './workflow-imports';

// Seed the OTel ID generator's PRNG from the workflow's PRNG, then advance
// the workflow PRNG once so the two sequences diverge immediately.
let otelRandom: RNG | undefined;

function getOtelRandom(): RNG {
  if (otelRandom === undefined) {
    // Use Math.random() (which is the workflow's deterministic PRNG) to
    // produce a seed for a SEPARATE alea instance. After this, the OTel
    // PRNG and the workflow PRNG are independent sequences.
    const seed = [Math.random(), Math.random(), Math.random(), Math.random()];
    otelRandom = alea(seed.map((v) => (v * 0x100000000) >>> 0));
  }
  return otelRandom;
}

function randomHex(length: number): string {
  const rng = getOtelRandom();
  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    const nibble = (rng() * 16) >>> 0;
    chars.push(nibble.toString(16));
  }
  return chars.join('');
}

/**
 * Reset the OTel PRNG so the next workflow gets a freshly seeded generator.
 * Must be called during workflow dispose since modules are shared across
 * workflow instances in the reusable VM.
 */
export function resetIdGenerator(): void {
  otelRandom = undefined;
}

/**
 * Generates span and trace IDs using a PRNG that is separate from the
 * workflow's Math.random(), preventing OTel ID generation from affecting
 * the deterministic sequence used by uuid4() for child workflow IDs.
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
