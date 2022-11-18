import { EventEmitter, on } from 'node:events';

/**
 * Return an async iterable that transforms items from a source iterable by mapping each item
 * through a mapping function.
 *
 * @param source the source async iterable
 * @param mapFn a mapping function to apply on every item of the source iterable
 */
export async function* mapAsyncIterable<A, B>(
  source: AsyncIterable<A>,
  mapFn: (val: A) => Promise<B>
): AsyncIterable<B> {
  for await (const x of source) {
    yield mapFn(x);
  }
}

/**
 * Return an async iterable that transforms items from a source iterable by concurrently mapping
 * each item through a mapping function.
 *
 * Mapped items are returned by the resulting iterator in the order they complete processing,
 * not the order in which the corresponding source items were obtained from the source iterator.
 *
 * @param source the source async iterable
 * @param mapFn a mapping function to apply on every item of the source iterable
 * @param concurrency maximum number of items to map concurrently
 */
export async function* raceMapAsyncIterable<A, B>(
  source: AsyncIterable<A>,
  mapFn: (val: A) => Promise<B>,
  concurrency: number
): AsyncIterable<B> {
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
