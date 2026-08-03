import { randomUUID } from 'crypto';
import test from 'ava';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { defaultOptions } from './mock-native-worker';
import { createTestWorkflowEnvironment } from './helpers-integration';
import { textEncoderDecoder, textEncoderDecoderFromImport } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test('Worker runtime exposes TextEncoder and TextDecoder as globals', async (t) => {
    const env = await createTestWorkflowEnvironment();
    try {
      const worker = await Worker.create({
        ...defaultOptions,
        taskQueue: 'test-worker-exposes-textencoderdecoder',
        connection: env.nativeConnection,
        namespace: env.namespace,
      });
      const result = await worker.runUntil(
        env.client.workflow.execute(textEncoderDecoder, {
          args: ['a string that will be encoded and decoded'],
          taskQueue: 'test-worker-exposes-textencoderdecoder',
          workflowId: randomUUID(),
          workflowExecutionTimeout: '5s',
        })
      );
      t.is(result, 'a string that will be encoded and decoded');
    } finally {
      await env.teardown();
    }
  });

  test('Worker runtime exposes TextEncoder and TextDecoder as overrided import of util', async (t) => {
    const env = await createTestWorkflowEnvironment();
    try {
      const worker = await Worker.create({
        ...defaultOptions,
        taskQueue: 'test-worker-exposes-textencoderdecoder',
        connection: env.nativeConnection,
        namespace: env.namespace,
      });
      const result = await worker.runUntil(
        env.client.workflow.execute(textEncoderDecoderFromImport, {
          args: ['a string that will be encoded and decoded'],
          taskQueue: 'test-worker-exposes-textencoderdecoder',
          workflowId: randomUUID(),
          workflowExecutionTimeout: '5s',
        })
      );
      t.is(result, 'a string that will be encoded and decoded');
    } finally {
      await env.teardown();
    }
  });
}
