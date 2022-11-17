import { EventEmitter, on } from 'node:events';

export async function* mapAsyncIterable<A, B>(
  source: AsyncIterable<A>,
  func: (val: A) => Promise<B>
): AsyncIterable<B> {
  for await (const x of source) {
    yield func(x);
  }
}

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
      })().catch((e) => console.error(e)); // FIXME-JWH: Deal with exceptions
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
