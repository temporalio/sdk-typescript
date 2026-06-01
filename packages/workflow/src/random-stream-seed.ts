import { encode } from '@temporalio/common/lib/encoding';

const RANDOM_STREAM_SEED_PREFIX = Array.from(encode('temporal-workflow-random-stream-v1'));

function encodeU32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

export function deriveAleaSeed(seed: number[], namespace: string): number[] {
  const namespaceBytes = Array.from(encode(namespace));
  return [
    ...RANDOM_STREAM_SEED_PREFIX,
    ...encodeU32(seed.length),
    ...seed,
    ...encodeU32(namespaceBytes.length),
    ...namespaceBytes,
  ];
}
