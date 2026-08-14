import test from 'ava';
import * as otel from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { instrumentAsyncIterable } from '../instrumentation';

/**
 * Minimal sync ContextManager so unit tests can assert active-context propagation
 * without adding @opentelemetry/context-async-hooks as a dependency.
 */
class TestContextManager implements otel.ContextManager {
  private current: otel.Context = otel.ROOT_CONTEXT;

  active(): otel.Context {
    return this.current;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: otel.Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const previous = this.current;
    this.current = context;
    try {
      return Reflect.apply(fn, thisArg, args);
    } finally {
      this.current = previous;
    }
  }

  bind<T>(context: otel.Context, target: T): T {
    if (typeof target !== 'function') {
      return target;
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- bind() needs the manager instance in the wrapper
    const manager = this;
    const bound = function (this: unknown, ...args: unknown[]) {
      return manager.with(context, () => (target as (...args: unknown[]) => unknown).apply(this, args));
    };
    return bound as T;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.current = otel.ROOT_CONTEXT;
    return this;
  }
}

function setupTracer(name: string) {
  const memoryExporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
  });
  otel.context.setGlobalContextManager(new TestContextManager().enable());
  return {
    memoryExporter,
    tracer: provider.getTracer(name),
  };
}

async function* values(items: number[]): AsyncIterable<number> {
  for (const item of items) {
    yield item;
  }
}

test('instrumentAsyncIterable does not open a span until iteration begins', async (t) => {
  const { memoryExporter, tracer } = setupTracer('lazy-start');
  const iterable = instrumentAsyncIterable({
    tracer,
    spanName: 'ListWorkflows',
    fn: () => values([1, 2, 3]),
  });

  t.is(memoryExporter.getFinishedSpans().length, 0);
  const iterator = iterable[Symbol.asyncIterator]();
  t.is(memoryExporter.getFinishedSpans().length, 0);

  t.is((await iterator.next()).value, 1);
  t.is(memoryExporter.getFinishedSpans().length, 0);

  t.is((await iterator.next()).value, 2);
  t.is((await iterator.next()).value, 3);
  t.true((await iterator.next()).done);

  const spans = memoryExporter.getFinishedSpans();
  t.is(spans.length, 1);
  t.is(spans[0]!.name, 'ListWorkflows');
  t.is(spans[0]!.status.code, SpanStatusCode.OK);
});

test('instrumentAsyncIterable ends the span exactly once on early break', async (t) => {
  const { memoryExporter, tracer } = setupTracer('early-break');
  const iterable = instrumentAsyncIterable({
    tracer,
    spanName: 'ListWorkflows',
    fn: () => values([1, 2, 3, 4]),
  });

  const seen: number[] = [];
  for await (const item of iterable) {
    seen.push(item);
    if (item === 2) {
      t.is(memoryExporter.getFinishedSpans().length, 0);
      break;
    }
  }

  t.deepEqual(seen, [1, 2]);
  const spans = memoryExporter.getFinishedSpans();
  t.is(spans.length, 1);
  t.is(spans[0]!.status.code, SpanStatusCode.OK);
});

test('instrumentAsyncIterable records errors and ends once', async (t) => {
  const { memoryExporter, tracer } = setupTracer('error');
  const error = new Error('downstream failed');
  async function* boom(): AsyncIterable<number> {
    yield 1;
    throw error;
  }

  const iterable = instrumentAsyncIterable({
    tracer,
    spanName: 'ListWorkflows',
    fn: () => boom(),
  });

  await t.throwsAsync(
    async () => {
      for await (const _ of iterable) {
        // consume until error
      }
    },
    { is: error }
  );

  const spans = memoryExporter.getFinishedSpans();
  t.is(spans.length, 1);
  t.is(spans[0]!.status.code, SpanStatusCode.ERROR);
  t.is(spans[0]!.status.message, error.message);
  t.is(spans[0]!.events.filter((event) => event.name === 'exception').length, 1);
});

test('instrumentAsyncIterable propagates active context to downstream next()', async (t) => {
  const { memoryExporter, tracer } = setupTracer('context');
  const iterable = instrumentAsyncIterable({
    tracer,
    spanName: 'ListWorkflows',
    fn: () => ({
      [Symbol.asyncIterator]() {
        let done = false;
        return {
          async next(): Promise<IteratorResult<number>> {
            if (done) {
              return { done: true, value: undefined };
            }
            done = true;
            const child = tracer.startSpan('child-during-next');
            child.end();
            return { done: false, value: 1 };
          },
        };
      },
    }),
  });

  for await (const _ of iterable) {
    // consume
  }

  const spans = memoryExporter.getFinishedSpans();
  const parent = spans.find((span) => span.name === 'ListWorkflows');
  const child = spans.find((span) => span.name === 'child-during-next');
  t.truthy(parent);
  t.truthy(child);
  t.is(child!.parentSpanContext?.spanId, parent!.spanContext().spanId);
});
