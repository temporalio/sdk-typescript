import { EventEmitter, on } from 'node:events';

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
  options: MapAsyncOptions
): AsyncIterable<B> {
  const { concurrency } = { concurrency: 1, ...(options ?? {}) };

  if (concurrency < 2) {
    for await (const x of source) {
      yield mapFn(x);
    }
    return;
  }

  const emiter = new EventEmitter();
  const sourceIterator = source[Symbol.asyncIterator]();
  let sourceIteratorDone = false;
  let pendingPromisesCount = 0;
  let pendingResultsCount = 0;

  async function maybeStartTasks() {
    while (!sourceIteratorDone && pendingPromisesCount + pendingResultsCount < concurrency) {
      const val = await sourceIterator.next();
      if (val.done) {
        sourceIteratorDone = true;
        return pendingPromisesCount > 0;
      }

      pendingPromisesCount++;
      (async () => {
        try {
          emiter.emit('result', await mapFn(val.value));
          pendingResultsCount++;
        } finally {
          pendingPromisesCount--;
        }
        return maybeStartTasks();
      })().catch((e) => emiter.emit('error', e));
    }

    return !sourceIteratorDone || pendingPromisesCount > 0;
  }

  // The listener must be registered before we start emiting events
  // through the emiter; otherwise, these events get silently discarded.
  const emiterEventsIterable = on(emiter, 'result');

  if (!(await maybeStartTasks())) return;
  for await (const [res] of emiterEventsIterable) {
    pendingResultsCount--;
    yield res as B;
    if (!(await maybeStartTasks())) return;
  }
}
