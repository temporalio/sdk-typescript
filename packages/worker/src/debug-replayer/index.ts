import worker_threads from 'node:worker_threads';
import { temporal } from '@temporalio/proto';
import { ReplayWorkerOptions } from '../worker-options';
import { Worker } from '../worker';
import { Client } from './client';

let thread: worker_threads.Worker | undefined = undefined;

async function run(options: ReplayWorkerOptions): Promise<void> {
  const baseUrl = process.env.TEMPORAL_DEBUGGER_PLUGIN_URL;
  if (!baseUrl) {
    throw new Error('Missing TEMPORAL_DEBUGGER_PLUGIN_URL environment variable');
  }
  const client = new Client({ baseUrl });
  const response = await client.get('history');
  const history = temporal.api.history.v1.History.decode(
    await Client.readAll(response),
    Client.contentLength(response)
  );

  // Only create one per process.
  // Not caring about globals here for to get simpler DX, this isn't meant for production use cases.
  thread = thread || new worker_threads.Worker(require.resolve('./worker-thread'));

  const rejectedPromise = new Promise<void>((_, reject) => {
    // Set the global notifyRunner runner function that can be used from the workflow interceptors.
    // The function makes an HTTP request to the runner in a separate thread and blocks the current thread until a
    // response is received.
    (globalThis as any).notifyRunner = (wftStartEventId: number) => {
      const sab = new SharedArrayBuffer(4);
      const responseBuffer = new Int32Array(sab);
      thread?.postMessage({ eventId: wftStartEventId, responseBuffer });
      Atomics.wait(responseBuffer, 0, 0);
      if (responseBuffer[0] === 2) {
        // Error occurred (logged by worker thread)
        reject(new Error('Failed to call runner back'));
      }
    };
  });

  await Promise.race([
    rejectedPromise,
    Worker.runReplayHistory(
      {
        ...options,
        interceptors: {
          ...options.interceptors,
          workflowModules: [
            // Inbound goes first so user can set breakpoints in own inbound interceptors.
            require.resolve('./inbound-interceptor'),
            ...(options.interceptors?.workflowModules ?? []),
            // Outbound goes last - notifies the runner in the finally block, user-provided outbound interceptors are
            // resumed after the interceptor methods resolve.
            require.resolve('./outbound-interceptor'),
          ],
        },
      },
      history
    ),
  ]);
}

/**
 * Start a replayer for debugging purposes.
 *
 * Use this method to integrate the replayer with external debuggers like the Temporal VS Code debbuger extension.
 */
export function startDebugReplayer(options: ReplayWorkerOptions): void {
  run(options).then(
    () => {
      console.log('Replay completed successfully');
      process.exit(0);
    },
    (err) => {
      console.error('Replay failed', err);
      process.exit(1);
    }
  );
}
