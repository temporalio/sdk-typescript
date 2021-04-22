import test from 'ava';
import { resolver } from '@temporalio/worker/lib/worker';
import { LoaderError } from '@temporalio/worker/lib/loader';

test('resolver resolves with .js extension', async (t) => {
  const resolve = resolver(__dirname, new Map());
  const resolved = await resolve(__filename.replace(`${__dirname}/`, ''));
  t.is(resolved, __filename);
});

test('resolver resolves without .js extension', async (t) => {
  const resolve = resolver(__dirname, new Map());
  const resolved = await resolve(__filename.replace(`${__dirname}/`, '').replace('.js', ''));
  t.is(resolved, __filename);
});

test('resolver throws if no override', async (t) => {
  const resolve = resolver(undefined, new Map());
  const err = await t.throwsAsync(() => resolve(__filename.replace(`${__dirname}/`, '')));
  t.true(err instanceof LoaderError);
  t.regex(err.message, /Could not find \S+ in overrides and no baseDir provided/);
});

test('resolver uses override', async (t) => {
  const resolve = resolver(undefined, new Map([['test', __filename]]));
  const resolved = await resolve('test');
  t.is(resolved, __filename);
});
