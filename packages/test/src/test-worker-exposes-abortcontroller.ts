import { randomUUID } from 'crypto';
import test from 'ava';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { defaultOptions } from './mock-native-worker';
import { createTestWorkflowEnvironment } from './helpers-integration';
import { abortController } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test(`Worker runtime exposes AbortController as a global`, async (t) => {
    const env = await createTestWorkflowEnvironment();
    try {
      const worker = await Worker.create({
        ...defaultOptions,
        taskQueue: 'test-worker-exposes-abortcontroller',
        connection: env.nativeConnection,
        namespace: env.namespace,
      });
      const result = await worker.runUntil(
        env.client.workflow.execute(abortController, {
          args: [],
          taskQueue: 'test-worker-exposes-abortcontroller',
          workflowId: randomUUID(),
          workflowExecutionTimeout: '5s',
        })
      );
      t.is(result, 'abort successful');
    } finally {
      await env.teardown();
    }
  });
}
