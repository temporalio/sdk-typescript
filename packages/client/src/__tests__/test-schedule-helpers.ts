import test from 'ava';
import { encodeOptionalStructuredCalendarSpecs } from '../schedule-helpers';

test('Calendar second range without an end matches only its start', (t) => {
  const encoded = encodeOptionalStructuredCalendarSpecs([
    { second: { start: 0 } },
    { second: 0 },
    { second: { start: 0, end: 1 } },
  ]);

  t.deepEqual(
    encoded?.map(({ second }) => second),
    [[{ start: 0, end: 0, step: 1 }], [{ start: 0, end: 0, step: 1 }], [{ start: 0, end: 1, step: 1 }]]
  );
});
