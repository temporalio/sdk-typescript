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

test(`mapAsyncIterable (with concurrency) closes the source iterable on early termination`, async (t) => {
  let sourceExited = 0;
  let produced = 0;

  async function* source(): AsyncIterable<number> {
    try {
      for (;;) {
        yield ++produced;
      }
    } finally {
      sourceExited += 1;
    }
  }

  const iterable = mapAsyncIterable(source(), sleepThatTime, { concurrency: 3, bufferLimit: 0 });
  const seen: number[] = [];
  for await (const value of iterable) {
    seen.push(value);
    if (seen.length === 4) {
      break;
    }
  }

  t.is(seen.length, 4);
  t.is(sourceExited, 1);
  // Producers may have pulled a few extra source items for in-flight work, but must stop after close.
  t.true(produced < 20);
});

test(`mapAsyncIterable (with concurrency) propagates source return errors on early termination`, async (t) => {
  const cleanupError = new Error('cleanup failed');
  let returnCalls = 0;
  const source: AsyncIterable<number> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: false as const, value: 1 };
        },
        async return() {
          returnCalls += 1;
          throw cleanupError;
        },
      };
    },
  };

  await t.throwsAsync(
    async () => {
      for await (const _ of mapAsyncIterable(source, sleepThatTime, { concurrency: 2 })) {
        break;
      }
    },
    { is: cleanupError }
  );
  t.is(returnCalls, 1);
});

test(`mapAsyncIterable (with concurrency) does not close a naturally exhausted source`, async (t) => {
  let nextCalls = 0;
  let returnCalls = 0;
  const source: AsyncIterable<number> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          nextCalls += 1;
          return nextCalls <= 2
            ? { done: false as const, value: nextCalls }
            : { done: true as const, value: undefined };
        },
        async return() {
          returnCalls += 1;
          return { done: true as const, value: undefined };
        },
      };
    },
  };

  const values: number[] = [];
  for await (const value of mapAsyncIterable(source, multBy10, { concurrency: 2 })) {
    values.push(value);
  }

  t.deepEqual(values.sort(), [10, 20]);
  t.is(returnCalls, 0);
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

test(`mapAsyncIterable (with concurrency) doesn't hang when a backpressured mapper fails`, async (t) => {
  const mapError = new Error('Map Exception');
  async function* source(): AsyncIterable<number> {
    for (let value = 1; ; value++) {
      yield value;
    }
  }

  const iterable = mapAsyncIterable(
    source(),
    async (value) => {
      if (value === 2) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        throw mapError;
      }
      return value;
    },
    { concurrency: 2, bufferLimit: 0 }
  );
  const iterator = iterable[Symbol.asyncIterator]();

  t.is((await iterator.next()).value, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  t.is((await iterator.next()).value, 3);
  await t.throwsAsync(iterator.next(), { is: mapError });
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
