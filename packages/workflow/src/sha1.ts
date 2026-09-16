import { encode } from '@temporalio/common/lib/encoding';

/**
 * Minimal SHA-1 implementation, for use inside the Workflow sandbox. This implementation
 * relies only on plain arithmetic, without requirement on the `crypto` module or any other
 * Node built-in.
 *
 * @internal
 */
export function sha1Hex(input: string): string {
  const message = encode(input);
  const messageBitLength = message.length * 8;

  // Padding: append 0x80, then 0x00 until the length is congruent to 56 (mod 64), then the original
  // message length as a 64-bit big-endian integer.
  const data = new Uint8Array(Math.ceil((message.length + 9) / 64) * 64);
  data.set(message);
  data[message.length] = 0x80;
  const hiLen = Math.floor(messageBitLength / 0x100000000);
  const loLen = messageBitLength >>> 0;
  const lengthPos = data.length - 8;
  data[lengthPos] = (hiLen >>> 24) & 0xff;
  data[lengthPos + 1] = (hiLen >>> 16) & 0xff;
  data[lengthPos + 2] = (hiLen >>> 8) & 0xff;
  data[lengthPos + 3] = hiLen & 0xff;
  data[lengthPos + 4] = (loLen >>> 24) & 0xff;
  data[lengthPos + 5] = (loLen >>> 16) & 0xff;
  data[lengthPos + 6] = (loLen >>> 8) & 0xff;
  data[lengthPos + 7] = loLen & 0xff;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);
  for (let chunk = 0; chunk < data.length; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      const j = chunk + i * 4;
      w[i] =
        (((data[j] ?? 0) << 24) | ((data[j + 1] ?? 0) << 16) | ((data[j + 2] ?? 0) << 8) | (data[j + 3] ?? 0)) >>> 0;
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl((w[i - 3] ?? 0) ^ (w[i - 8] ?? 0) ^ (w[i - 14] ?? 0) ^ (w[i - 16] ?? 0), 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + (f >>> 0) + (e >>> 0) + k + (w[i] ?? 0)) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}

/** Rotate a 32-bit value left by `n` bits. */
function rotl(value: number, n: number): number {
  return ((value << n) | (value >>> (32 - n))) >>> 0;
}
