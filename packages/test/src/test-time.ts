import test from 'ava';
import Long from 'long';
import { msStrToTs } from '@temporalio/workflow/lib/time';

test('msStrToTs converts to Timestamp', (t) => {
  t.deepEqual({ seconds: Long.fromInt(600), nanos: 0 }, msStrToTs('10 minutes'));
});
