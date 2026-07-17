/**
 * Minimal, dependency-free SHA-1 implementation.
 *
 * Event Group label identifiers are derived deterministically from the label text (see the Event
 * Groups design). That derivation runs inside the Workflow sandbox, where Node's `crypto` module is
 * not available, so we cannot use `crypto.createHash('sha1')`. This implementation relies only on
 * plain arithmetic and string operations and is therefore safe to run in the deterministic Workflow
 * environment.
 *
 * SHA-1 is used here for preimage resistance (making the identifier a one-way function of the label),
 * not collision resistance; see the design's security rationale.
 *
 * @internal
 */
export function sha1Hex(input: string): string {
  const bytes = utf8Bytes(input);
  const messageBitLength = bytes.length * 8;

  // Padding: append 0x80, then 0x00 until the length is congruent to 56 (mod 64), then the original
  // message length as a 64-bit big-endian integer.
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0x00);
  const hiLen = Math.floor(messageBitLength / 0x100000000);
  const loLen = messageBitLength >>> 0;
  bytes.push((hiLen >>> 24) & 0xff, (hiLen >>> 16) & 0xff, (hiLen >>> 8) & 0xff, hiLen & 0xff);
  bytes.push((loLen >>> 24) & 0xff, (loLen >>> 16) & 0xff, (loLen >>> 8) & 0xff, loLen & 0xff);

  // Use typed arrays so element access is typed as `number` (works under `noUncheckedIndexedAccess`)
  // and 32-bit truncation happens on store.
  const data = Uint8Array.from(bytes);

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

/** Encode a string as UTF-8 bytes, without relying on `TextEncoder` or any Node built-in. */
function utf8Bytes(str: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let codePoint = str.charCodeAt(i);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (codePoint < 0x80) {
      out.push(codePoint);
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      out.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    }
  }
  return out;
}
