/* eslint @typescript-eslint/no-non-null-assertion: 0 */
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Worker, DefaultLogger } from '@temporalio/worker';
import { Connection } from '@temporalio/client';
import { defaultDataConverter } from '@temporalio/workflow';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS } from './helpers';

if (RUN_INTEGRATION_TESTS) {
  test('Tracing can be implemented using interceptors', async (t) => {
    const taskQueue = 'test-interceptors';
    const message = uuid4();

    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      logger: new DefaultLogger('DEBUG'),
      interceptors: {
        activityInbound: [
          () => ({
            async execute(input, next) {
              const encoded = input.headers.get('message');
              const receivedMessage = encoded ? defaultDataConverter.fromPayload(encoded) : '';
              return next({ ...input, args: [receivedMessage] });
            },
          }),
        ],
        workflowModules: ['interceptor-example'],
      },
    });
    const p = worker.run();
    const conn = new Connection({
      interceptors: {
        workflowClient: [
          () => ({
            async start(input, next) {
              input.headers.set('message', defaultDataConverter.toPayload(message));
              return next(input);
            },
          }),
        ],
      },
    });
    const wf = conn.workflow<{ main(): string }>('interceptor-example', { taskQueue });
    const result = await wf.start();
    worker.shutdown();
    await p;
    t.is(result, message);
  });
}
