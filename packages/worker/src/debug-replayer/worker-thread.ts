/**
 * Worker thread entrypoint used by ./index.ts to synchronously make an HTTP call to the "runner".
 */
import { isMainThread, parentPort as parentPortOrNull } from 'node:worker_threads';
import { Client } from './client';

/**
 * Request from parent thread, the worker thread should signal a "runner" when it gets this request.
 */
export interface Request {
  type: 'wft-started';
  /**
   * Event ID of the started request.
   */
  eventId: number;
  /**
   * Used to signal back that the request is complete.
   */
  responseBuffer: Int32Array;
}

if (isMainThread) {
  throw new Error(`Imported ${__filename} from main thread`);
}

if (parentPortOrNull === null) {
  throw new TypeError(`${__filename} got a null parentPort`);
}

// Create a new parentPort variable that is not nullable to please TS
const parentPort = parentPortOrNull;

const baseUrl = process.env.TEMPORAL_DEBUGGER_PLUGIN_URL;
if (!baseUrl) {
  throw new Error('Missing TEMPORAL_DEBUGGER_PLUGIN_URL environment variable');
}
const client = new Client({ baseUrl });

parentPort.on('message', async (request: Request) => {
  const { eventId, responseBuffer } = request;
  try {
    await client.post(
      'current-wft-started',
      { headers: { 'Content-Type': 'application/json' }, timeout: 5000 },
      Buffer.from(JSON.stringify({ eventId }))
    );
    Atomics.store(responseBuffer, 0, 1);
  } catch (err) {
    console.error(err);
    Atomics.store(responseBuffer, 0, 2);
  } finally {
    Atomics.notify(responseBuffer, 0, 1);
  }
});
