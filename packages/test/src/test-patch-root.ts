import test from 'ava';
import { patchRoot } from '@temporalio/common';

test('patchRoot', (t) => {
  t.deepEqual(patchRoot({ nested: { foo: 1 } }), { foo: 1 } as any);
  t.deepEqual(patchRoot({ nested: { foo: { Msg: 1, nested: { bar: { BarMsg: 2 } } } } }), {
    foo: { Msg: 1, bar: { BarMsg: 2 } },
  } as any);
  t.deepEqual(patchRoot({ Capital: { nested: { foo: 1 } } }), { Capital: { foo: 1 } } as any);
});
