import test from 'ava';

import Long from 'long';
import type { Duration, StringValue } from '../index';
import { msOptionalToTs, msToNumber, msToTs } from '../time';

test('msToTs converts to Timestamp', (t) => {
  t.deepEqual({ seconds: Long.fromInt(600), nanos: 0 }, msToTs('10 minutes'));
});

test('msToTs converts number to Timestamp', (t) => {
  const duration: Duration = 42000;
  t.deepEqual({ seconds: Long.fromInt(42), nanos: 0 }, msToTs(duration));
});

test('msOptionalToTs converts zero duration to Timestamp', (t) => {
  t.deepEqual({ seconds: Long.fromInt(0), nanos: 0 }, msOptionalToTs(0));
});

const durations: [StringValue, number][] = [
  ['0', 0],
  ['1.5 hours', 5_400_000],
  ['-10s', -10_000],
  ['1y', 31_557_600_000],
  ['1 month', 2_629_800_000],
  ['2 MONTHS', 5_259_600_000],
  ['1mo', 2_629_800_000],
];

for (const [duration, milliseconds] of durations) {
  test(`msToNumber parses ${duration}`, (t) => {
    t.is(msToNumber(duration), milliseconds);
  });
}

test('msToNumber rejects invalid duration strings', (t) => {
  t.throws(() => msToNumber('1 fortnight' as Duration), {
    instanceOf: TypeError,
    message: "Invalid duration string: '1 fortnight'",
  });
});
