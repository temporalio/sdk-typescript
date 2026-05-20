import test from 'ava';
import { randomUUID } from 'node:crypto';
import { Client } from '@temporalio/client';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { defaultOptions } from './mock-native-worker';
import { textEncoderDecoder, textEncoderDecoderFromImport } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  test('Worker runtime exposes TextEncoder and TextDecoder as globals', async (t) => {
    const worker = await Worker.create({ ...defaultOptions, taskQueue: 'test-worker-exposes-textencoderdecoder' });
    const client = new Client();
    const result = await worker.runUntil(
      client.workflow.execute(textEncoderDecoder, {
        args: ['a string that will be encoded and decoded'],
        taskQueue: 'test-worker-exposes-textencoderdecoder',
        workflowId: randomUUID(),
        workflowExecutionTimeout: '5s',
      })
    );
    t.is(result, 'a string that will be encoded and decoded');
  });

  test('Worker runtime exposes TextEncoder and TextDecoder as overrided import of util', async (t) => {
    const worker = await Worker.create({ ...defaultOptions, taskQueue: 'test-worker-exposes-textencoderdecoder' });
    const client = new Client();
    const result = await worker.runUntil(
      client.workflow.execute(textEncoderDecoderFromImport, {
        args: ['a string that will be encoded and decoded'],
        taskQueue: 'test-worker-exposes-textencoderdecoder',
        workflowId: randomUUID(),
        workflowExecutionTimeout: '5s',
      })
    );
    t.is(result, 'a string that will be encoded and decoded');
  });
}
