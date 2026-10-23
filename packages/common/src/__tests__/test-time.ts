import test from 'ava';

import Long from 'long';
import type { Duration } from '../time';
import { msOptionalToTs, msToNumber, msToTs, tsToMs } from '../time';

test('msToTs converts to Timestamp', (t) => {
  t.deepEqual({ seconds: Long.fromInt(600), nanos: 0 }, msToTs('10 minutes'));
});

test('msToTs converts number to Timestamp', (t) => {
  t.deepEqual({ seconds: Long.fromInt(42), nanos: 0 }, msToTs(42000));
});

test('msOptionalToTs converts zero duration to Timestamp', (t) => {
  t.deepEqual({ seconds: Long.fromInt(0), nanos: 0 }, msOptionalToTs(0));
});

test('msToNumber rejects invalid duration strings', (t) => {
  t.throws(() => msToNumber('1 fortnight' as Duration), {
    instanceOf: TypeError,
    message: "Invalid duration string: '1 fortnight'",
  });
});

test('tsToMs accepts numeric timestamp seconds', (t) => {
  t.is(tsToMs({ seconds: 42, nanos: 500_000_000 }), 42_500);
  t.is(tsToMs({ seconds: -1, nanos: 500_000_000 }), -500);
  t.is(tsToMs({ seconds: Long.fromInt(42), nanos: 500_000_000 }), 42_500);
});
