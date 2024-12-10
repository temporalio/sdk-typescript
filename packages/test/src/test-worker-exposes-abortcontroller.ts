import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Client } from '@temporalio/client';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { defaultOptions } from './mock-native-worker';
import { abortController } from './workflows';


if (RUN_INTEGRATION_TESTS) {
  for (const [reuseV8Context, debugMode] of [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ]) {
    test(`Worker runtime exposes AbortController as a global (reuseV8Context: ${reuseV8Context}, debugMode: ${debugMode})`, async (t) => {
      const worker = await Worker.create({ ...defaultOptions, taskQueue: 'test-worker-exposes-abortcontroller', reuseV8Context, debugMode });
      const client = new Client();
      const result = await worker.runUntil(
        client.workflow.execute(abortController, {
          args: [],
          taskQueue: 'test-worker-exposes-abortcontroller',
          workflowId: uuid4(),
          workflowExecutionTimeout: '5s',
        })
      );
      t.is(result, 'abort successful');
    });
  }
}
