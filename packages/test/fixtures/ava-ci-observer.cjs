'use strict';

const test = require('ava');

if (process.env.AVA_OBSERVER_FIXTURE_MODE === 'hang') {
  test.serial('completed before hang', (t) => t.pass());
  test.serial(
    'never completes',
    async () =>
      await new Promise(() => {
        setInterval(() => {}, 1000);
      })
  );
} else {
  const macro = (t, value) => t.is(value, 'value');
  macro.title = () => 'macro case';

  test.serial('serial case', (t) => t.pass());
  test('concurrent case', async (t) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    t.pass();
  });
  test(macro, 'value');
}
