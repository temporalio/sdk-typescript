import * as net from 'net';

/**
 * Return a random TCP port number, that is guaranteed to be either available, or to be in use.
 *
 * To get a port that is guaranteed to be available, simply call the function directly.
 *
 * ```ts
 * const port = await getRandomPort();
 * ```
 *
 * To get a port that is guaranteed to be in use, pass a function that will be called with the port
 * number; the port is guaranteed to be in use until the function returns. This may be useful for
 * example to test for proper error handling when a port is already in use.
 *
 * ```ts
 * const port = await getRandomPort(async (port) => {
 *     t.throws(
 *       () => startMyService({ bindAddress: `127.0.0.1:${port}` }),
 *       {
 *         instanceOf: Error,
 *         message: /(Address already in use|socket address)/,
 *       }
 *     );
 *   });
 * });
 * ```
 */
export async function getRandomPort(fn = (_port: number) => Promise.resolve()): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const addr = srv.address();
      if (typeof addr === 'string' || addr === null) {
        throw new Error('Unexpected server address type');
      }
      fn(addr.port)
        .catch((e) => reject(e))
        .finally(() => srv.close((_) => resolve(addr.port)));
    });
  });
}
