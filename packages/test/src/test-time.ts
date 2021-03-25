import test from 'ava';
import { msStrToTs } from '@temporalio/workflow/commonjs/time';

test('msStrToTs converts to Timestamp', (t) => {
  t.deepEqual({ seconds: 600, nanos: 0 }, msStrToTs('10 minutes'));
});
