import test from 'ava';

import Long from 'long';
import { msToTs } from '../time';

test('msToTs converts to Timestamp', (t) => {
  t.deepEqual({ seconds: Long.fromInt(600), nanos: 0 }, msToTs('10 minutes'));
});

test('msToTs converts number to Timestamp', (t) => {
  t.deepEqual({ seconds: Long.fromInt(42), nanos: 0 }, msToTs(42000));
});
