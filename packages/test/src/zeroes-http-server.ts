/* eslint-disable @typescript-eslint/ban-ts-comment */
import http from 'http';
import { sleep } from './helpers';

/**
 * Creates an HTTP server which responds with zeroes on /zeroes.
 * @param callback called with the port and a promise that resolves when /finish is called once the server is ready, the server will close when the callback completes
 * @param numIterations write zeroes into response every iteration
 * @param bytesPerIteration number of bytes to respond with on each iteration
 * @param msForCompleteResponse approximate number of milliseconds the response should take
 */
export async function withZeroesHTTPServer(
  callback: (port: number) => Promise<any>,
  numIterations = 100,
  bytesPerIteration = 1024,
  msForCompleteResponse = 5000
): Promise<void> {
  const server = http.createServer(async (_req, res) => {
    res.writeHead(200, 'OK', { 'Content-Length': `${bytesPerIteration * numIterations}` });
    for (let i = 0; i < numIterations; ++i) {
      await sleep(msForCompleteResponse / numIterations);
      res.write(Buffer.alloc(bytesPerIteration));
    }
    res.end();
  });
  server.listen();
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) {
    throw new Error('Unexpected server address type');
  }
  try {
    await callback(addr.port);
  } finally {
    server.close();
  }
}
