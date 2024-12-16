import test from 'ava';
import { mapAsyncIterable } from '@temporalio/client/lib/iterators-utils';

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

  const iterable = mapAsyncIterable(name(), sleepThatTime, { concurrency: 5, bufferLimit: 8 });
  const iterator = iterable[Symbol.asyncIterator]();

  t.is(counter, 0);
  await iterator.next();

  // One already read + 5 pending
  t.is(counter, 6);
  await iterator.next();
  t.is(counter, 7);

  // Give time for buffer to get filled
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Two already read + 8 buffered results + 5 concurrent results
  t.is(counter, 15);
});

test(`mapAsyncIterable (with concurrency) doesn't hang on source exceptions`, async (t) => {
  async function* name(): AsyncIterable<number> {
    for (;;) {
      yield 1;
      yield 2;
      yield 3;
      yield 4;
      throw new Error('Test Exception');
    }
  }

  const iterable = mapAsyncIterable(name(), sleepThatTime, { concurrency: 2, bufferLimit: 8 });
  const iterator = iterable[Symbol.asyncIterator]();

  // Get the iterator started
  await iterator.next();

  // Give time for buffer to get filled
  await new Promise((resolve) => setTimeout(resolve, 100));

  await iterator.next();
  await iterator.next();

  await t.throwsAsync(iterator.next(), {
    instanceOf: Error,
    message: 'Test Exception',
  });
});

// FIXME: This test is producing rare flakes
test(`mapAsyncIterable (with concurrency) doesn't hang mapFn exceptions`, async (t) => {
  async function* name(): AsyncIterable<number> {
    for (let i = 0; i < 1000; i++) {
      yield i;
    }
  }

  const iterable = mapAsyncIterable(
    name(),
    async (x: number) => {
      await sleepThatTime(x * 10);
      if (x === 4) throw new Error('Test Exception');
      return x;
    },
    { concurrency: 2, bufferLimit: 8 }
  );
  const iterator = iterable[Symbol.asyncIterator]();

  // Start the iterator
  await iterator.next();

  // Give time for buffer to get filled
  await new Promise((resolve) => setTimeout(resolve, 100));

  const values: (number | string | boolean)[] = [];
  for (let i = 0; i < 6; i++) {
    try {
      const res = await iterator.next();
      values.push(res.value ?? res.done);
    } catch (_error) {
      values.push('error');
    }
  }

  t.deepEqual(values.sort(), [1, 2, 3, 'error', true, true]);
});

async function multBy10(x: number): Promise<number> {
  return Promise.resolve(x * 10);
}

async function sleepThatTime(x: number): Promise<number> {
  return new Promise((resolve) => setTimeout(() => resolve(x), x));
}
