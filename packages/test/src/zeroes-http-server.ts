/* eslint-disable @typescript-eslint/ban-ts-comment */
import http from 'http';
import { sleep } from './helpers';

/**
 * Helper for creating promises which can be manually resolved
 */
class ResolvablePromise<T> implements PromiseLike<T> {
  public readonly then: <TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ) => PromiseLike<TResult1 | TResult2>;

  // @ts-ignore
  public readonly resolve: (value: T | PromiseLike<T>) => void;
  // @ts-ignore
  public readonly reject: (reason?: any) => void;

  constructor() {
    const promise = new Promise<T>((resolve, reject) => {
      // @ts-ignore
      this.resolve = resolve;
      // @ts-ignore
      this.reject = reject;
    });
    this.then = promise.then.bind(promise);
  }
}

/**
 * Creates an HTTP server which responds with zeroes on /zeroes.
 * @param callback called with the port and a promise that resolves when /finish is called once the server is ready, the server will close when the callback completes
 * @param numIterations write zeroes into response every iteration
 * @param bytesPerIteration number of bytes to respond with on each iteration
 * @param msForCompleteResponse approximate number of milliseconds the response should take
 */
export async function withZeroesHTTPServer(
  callback: (port: number, finished: PromiseLike<void>) => Promise<any>,
  numIterations = 100,
  bytesPerIteration = 1024,
  msForCompleteResponse = 5000
): Promise<void> {
  const finished = new ResolvablePromise<void>();
  const server = http.createServer(async (req, res) => {
    const { url } = req;
    switch (url) {
      case '/zeroes':
        res.writeHead(200, 'OK', { 'Content-Length': `${bytesPerIteration * numIterations}` });
        for (let i = 0; i < numIterations; ++i) {
          await sleep(msForCompleteResponse / numIterations);
          res.write(Buffer.alloc(bytesPerIteration));
        }
        res.end();
        break;
      case '/finish':
        finished.resolve(undefined);
        res.writeHead(200, 'OK', { 'Content-Length': '2' });
        res.write('OK');
        res.end();
        break;
    }
  });
  server.listen();
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) {
    throw new Error('Unexpected server address type');
  }
  try {
    await callback(addr.port, finished);
  } finally {
    server.close();
  }
}
