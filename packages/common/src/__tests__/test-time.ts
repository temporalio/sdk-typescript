import test from 'ava';

import Long from 'long';
import { msOptionalToTs, msToTs } from '../time';

test('msToTs converts to Timestamp', (t) => {
  t.deepEqual({ seconds: Long.fromInt(600), nanos: 0 }, msToTs('10 minutes'));
});

test('msToTs converts number to Timestamp', (t) => {
  t.deepEqual({ seconds: Long.fromInt(42), nanos: 0 }, msToTs(42000));
});

test('msOptionalToTs converts zero duration to Timestamp', (t) => {
  t.deepEqual({ seconds: Long.fromInt(0), nanos: 0 }, msOptionalToTs(0));
});
