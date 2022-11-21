import { mapAsyncIterable } from '@temporalio/client/lib/iterators-utils';
import test from 'ava';

test(`mapAsyncIterable (with no concurrency) returns mapped values`, async (t) => {
  async function* source(): AsyncIterable<number> {
    yield 1;
    yield new Promise((resolve) => setTimeout(resolve, 50)).then(() => 2);
    yield Promise.resolve(3);
  }
  const iterable = mapAsyncIterable(source(), multBy10);

  const results: number[] = [];
  for await (const res of iterable) {
    results.push(res);
  }
  t.deepEqual(results, [10, 20, 30]);
});

test(`mapAsyncIterable's (with no concurrency) source function not executed until the mapped iterator actually get invoked`, async (t) => {
  let invoked = false;

  async function* name(): AsyncIterable<number> {
    invoked = true;
    yield 1;
  }

  const iterable = mapAsyncIterable(name(), multBy10);
  const iterator = iterable[Symbol.asyncIterator]();

  await Promise.resolve();

  t.false(invoked);
  t.is(await (await iterator.next()).value, 10);
  t.true(invoked);
});

test(`mapAsyncIterable (with no concurrency) doesn't consume more input that required`, async (t) => {
  let counter = 0;

  async function* name(): AsyncIterable<number> {
    for (;;) {
      yield counter++;
    }
  }

  const iterable = mapAsyncIterable(name(), multBy10);
  const iterator = iterable[Symbol.asyncIterator]();

  t.is(await (await iterator.next()).value, 0);
  t.is(await (await iterator.next()).value, 10);
  await Promise.resolve();
  t.is(counter, 2);
});

test(`mapAsyncIterable (with concurrency) run tasks concurrently`, async (t) => {
  async function* name(): AsyncIterable<number> {
    yield 200;
    yield 1;
    yield 1;
    yield 200;
    yield 1;
    yield 1;
    yield 200;
    yield 1;
    yield 1;
  }

  const iterable = mapAsyncIterable(name(), sleepThatTime, { concurrency: 4 });

  const startTime = Date.now();
  const values: number[] = [];
  for await (const val of iterable) {
    values.push(val);
  }
  const endTime = Date.now();

  t.deepEqual(values, [1, 1, 1, 1, 1, 1, 200, 200, 200]);
  t.truthy(endTime - startTime < 400);
});

test(`mapAsyncIterable (with concurrency) source function not executed until the mapped iterator actually get invoked`, async (t) => {
  let invoked = false;

  async function* name(): AsyncIterable<number> {
    invoked = true;
    yield 1;
  }

  const iterable = mapAsyncIterable(name(), multBy10, { concurrency: 4 });
  const iterator = iterable[Symbol.asyncIterator]();

  await Promise.resolve();

  t.false(invoked);
  t.is(await (await iterator.next()).value, 10);
  t.true(invoked);
});

test(`mapAsyncIterable (with concurrency) doesn't consume more input than required`, async (t) => {
  let counter = 0;

  async function* name(): AsyncIterable<number> {
    for (;;) {
      yield ++counter;
    }
  }

  const iterable = mapAsyncIterable(name(), sleepThatTime, { concurrency: 5 });
  const iterator = iterable[Symbol.asyncIterator]();

  t.is((await iterator.next()).value, 1);
  t.is((await iterator.next()).value, 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  t.is((await iterator.next()).value, 3);
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Exact count could vary slightly due to some promise timing, but should be
  // no more than (number of items read from output iterator + concurrency - 1)
  // The minus one at the end of the formula is because the `maybeStartTasks()`
  // following the yield in `mapAsyncIterable()` will only be called on
  // next call to `iterator.next()`;
  t.true(counter <= 7);
});

async function multBy10(x: number): Promise<number> {
  return Promise.resolve(x * 10);
}

async function sleepThatTime(x: number): Promise<number> {
  return new Promise((resolve) => setTimeout(() => resolve(x), x));
}
