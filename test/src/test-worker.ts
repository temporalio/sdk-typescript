import test from 'ava';
import { resolver } from '../../lib/worker';
import { LoaderError } from '../../lib/loader';

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
  const resolve = resolver(null, new Map());
  const err = await t.throwsAsync(() => resolve(__filename.replace(`${__dirname}/`, '')));
  t.true(err instanceof LoaderError);
  t.regex(err.message, /Could not find \S+ in overrides and no baseDir provided/);
});

test('resolver uses override', async (t) => {
  const resolve = resolver(null, new Map([['test', __filename]]));
  const resolved = await resolve('test');
  t.is(resolved, __filename);
});
