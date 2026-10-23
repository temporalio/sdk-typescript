import { setImmediate } from 'node:timers/promises';
import test from 'ava';
import * as otel from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import { node } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { instrumentAsyncIterable } from '../instrumentation';

function setupTracer(name: string) {
  const memoryExporter = new InMemorySpanExporter();
  const provider = new node.NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
  });
  provider.register();
  return {
    memoryExporter,
    tracer: provider.getTracer(name),
  };
}

test.afterEach.always(() => {
  otel.trace.disable();
  otel.context.disable();
});

async function* values(items: number[]): AsyncIterable<number> {
  for (const item of items) {
    yield item;
  }
}

test.serial('instrumentAsyncIterable does not open a span until iteration begins', async (t) => {
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

test.serial('instrumentAsyncIterable ends the span exactly once on early break', async (t) => {
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

test.serial('instrumentAsyncIterable records errors and ends once', async (t) => {
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

test.serial('instrumentAsyncIterable propagates active context across awaits in next()', async (t) => {
  const { memoryExporter, tracer } = setupTracer('context');
  const callerContext = otel.context.active();
  const iterable = instrumentAsyncIterable({
    tracer,
    spanName: 'ListWorkflows',
    fn: () => ({
      [Symbol.asyncIterator]() {
        let value = 0;
        return {
          async next(): Promise<IteratorResult<number>> {
            if (value === 2) return { done: true, value: undefined };
            await setImmediate();
            const child = tracer.startSpan('child-during-next');
            child.end();
            return { done: false, value: ++value };
          },
        };
      },
    }),
  });

  const seen: number[] = [];
  for await (const value of iterable) {
    seen.push(value);
    t.is(otel.context.active(), callerContext);
  }

  t.deepEqual(seen, [1, 2]);
  const spans = memoryExporter.getFinishedSpans();
  const parent = spans.find((span) => span.name === 'ListWorkflows');
  const children = spans.filter((span) => span.name === 'child-during-next');
  t.truthy(parent);
  t.is(children.length, 2);
  for (const child of children) {
    t.is(child.parentSpanContext?.spanId, parent!.spanContext().spanId);
    t.is(child.spanContext().traceId, parent!.spanContext().traceId);
  }
  t.is(otel.context.active(), callerContext);
});

for (const method of ['return', 'throw'] as const) {
  test.serial(`instrumentAsyncIterable propagates active context across awaits in ${method}()`, async (t) => {
    const { memoryExporter, tracer } = setupTracer(`context-${method}`);
    const callerContext = otel.context.active();
    async function cleanup() {
      await setImmediate();
      const child = tracer.startSpan('child-during-cleanup');
      child.end();
    }
    const iterable = instrumentAsyncIterable({
      tracer,
      spanName: 'ListWorkflows',
      fn: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<number>> {
              return { done: false, value: 1 };
            },
            async return(): Promise<IteratorResult<number>> {
              await cleanup();
              return { done: true, value: undefined };
            },
            async throw(error?: unknown): Promise<IteratorResult<number>> {
              await cleanup();
              throw error;
            },
          };
        },
      }),
    });
    const iterator = iterable[Symbol.asyncIterator]();
    t.is((await iterator.next()).value, 1);
    if (method === 'return') {
      t.true((await iterator.return!()).done);
    } else {
      const error = new Error('consumer failed');
      await t.throwsAsync(iterator.throw!(error), { is: error });
    }

    const spans = memoryExporter.getFinishedSpans();
    const parent = spans.find((span) => span.name === 'ListWorkflows');
    const child = spans.find((span) => span.name === 'child-during-cleanup');
    t.truthy(parent);
    t.truthy(child);
    t.is(child!.parentSpanContext?.spanId, parent!.spanContext().spanId);
    t.is(child!.spanContext().traceId, parent!.spanContext().traceId);
    t.is(otel.context.active(), callerContext);
  });
}
