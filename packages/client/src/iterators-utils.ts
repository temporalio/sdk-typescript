import 'abort-controller/polyfill'; // eslint-disable-line import/no-unassigned-import
import { EventEmitter, on, once } from 'node:events';
import { isAbortError } from '@temporalio/common/lib/type-helpers';

export interface MapAsyncOptions {
  /**
   * How many items to map concurrently. If set to less than 2 (or not set), then items are not mapped concurrently.
   *
   * When items are mapped concurrently, mapped items are returned by the resulting iterator in the order they complete
   * mapping, not the order in which the corresponding source items were obtained from the source iterator.
   *
   * @default 1 (ie. items are not mapped concurrently)
   */
  concurrency?: number;

  /**
   * Maximum number of mapped items to keep in buffer, ready for consumption.
   *
   * Ignored unless `concurrency > 1`. No limit applies if set to `undefined`.
   *
   * @default unlimited
   */
  bufferLimit?: number | undefined;
}

function toAsyncIterator<A>(iterable: AsyncIterable<A>): AsyncIterator<A> {
  return iterable[Symbol.asyncIterator]();
}

/**
 * Return an async iterable that transforms items from a source iterable by mapping each item
 * through a mapping function.
 *
 * If `concurrency > 1`, then up to `concurrency` items may be mapped concurrently. In that case,
 * items are returned by the resulting iterator in the order they complete processing, not the order
 * in which the corresponding source items were obtained from the source iterator.
 *
 * @param source the source async iterable
 * @param mapFn a mapping function to apply on every item of the source iterable
 */
export async function* mapAsyncIterable<A, B>(
  source: AsyncIterable<A>,
  mapFn: (val: A) => Promise<B>,
  options?: MapAsyncOptions
): AsyncIterable<B> {
  const { concurrency, bufferLimit } = options ?? {};

  if (!concurrency || concurrency < 2) {
    for await (const x of source) {
      yield mapFn(x);
    }
    return;
  }

  const sourceIterator = toAsyncIterator(source);

  const emitter = new EventEmitter();
  const controller = new AbortController();
  const emitterEventsIterable: AsyncIterable<[B]> = on(emitter, 'result', { signal: controller.signal });
  const emitterError: Promise<unknown[]> = once(emitter, 'error');

  const bufferLimitSemaphore =
    typeof bufferLimit === 'number'
      ? (() => {
          const releaseEvents: AsyncIterator<void> = toAsyncIterator(
            on(emitter, 'released', { signal: controller.signal })
          );
          let value = bufferLimit + concurrency;

          return {
            acquire: async () => {
              while (value <= 0) {
                await Promise.race([releaseEvents.next(), emitterError]);
              }
              value--;
            },
            release: () => {
              value++;
              emitter.emit('released');
            },
          };
        })()
      : undefined;

  const mapper = async () => {
    for (;;) {
      await bufferLimitSemaphore?.acquire();
      const val = await Promise.race([sourceIterator.next(), emitterError]);

      if (Array.isArray(val)) return;
      if ((val as IteratorResult<[B]>)?.done) return;

      emitter.emit('result', await mapFn(val.value));
    }
  };

  const mappers = Array(concurrency)
    .fill(mapper)
    .map((f: typeof mapper) => f());

  Promise.all(mappers).then(
    () => controller.abort(),
    (err) => emitter.emit('error', err)
  );

  try {
    for await (const [res] of emitterEventsIterable) {
      bufferLimitSemaphore?.release();
      yield res;
    }
  } catch (err: unknown) {
    if (isAbortError(err)) {
      return;
    }
    throw err;
  }
}
