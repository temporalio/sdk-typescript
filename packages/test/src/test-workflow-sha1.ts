import { createHash } from 'crypto';
import test from 'ava';
import { sha1Hex } from '@temporalio/workflow/lib/sha1';

// SHA-1 is used to derive Event Group IDs from their labels, but Node's `crypto` is unavailable
// inside the Workflow isolate. `@temporalio/workflow` therefore carries its own SHA-1, including
// its own UTF-8 encoder. Both are checked here against Node's implementation.

function nodeSha1Hex(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex');
}

test('sha1Hex produces the published SHA-1 test vectors', (t) => {
  t.is(sha1Hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  t.is(sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
});

test('sha1Hex matches Node across message length padding boundaries', (t) => {
  // SHA-1 processes 64-byte blocks and reserves the last 8 bytes of the final block for the message
  // length, so a message of 56 bytes (mod 64) is where padding spills into an additional block.
  for (let length = 0; length <= 130; length++) {
    const input = 'a'.repeat(length);
    t.is(sha1Hex(input), nodeSha1Hex(input), `length ${length}`);
  }
});

test('sha1Hex hashes the UTF-8 encoding of non-ASCII input', (t) => {
  for (const input of [
    'café', // 2-byte code point
    '☕', // 3-byte code point
    '🧉', // 4-byte code point, a surrogate pair in JavaScript
    '\u0000\u007f\u0080\u07ff\u0800\uffff', // one code point on either side of each length boundary
    'paiement-café-☕-🧉',
  ]) {
    t.is(sha1Hex(input), nodeSha1Hex(input), `input ${JSON.stringify(input)}`);
  }
});
