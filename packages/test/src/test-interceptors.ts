/* eslint @typescript-eslint/no-non-null-assertion: 0 */
/**
 * E2E Tests for the various SDK interceptors.
 * Tests run serially to improve CI reliability..
 * @module
 */

import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Worker, DefaultLogger } from '@temporalio/worker';
import {
  Connection,
  WorkflowClient,
  WorkflowExecutionFailedError,
  WorkflowExecutionTerminatedError,
} from '@temporalio/client';
import { defaultDataConverter } from '@temporalio/workflow';
import { defaultOptions } from './mock-native-worker';
import { Sleeper, Empty } from './interfaces';
import { RUN_INTEGRATION_TESTS } from './helpers';

if (RUN_INTEGRATION_TESTS) {
  test.serial('Tracing can be implemented using interceptors', async (t) => {
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
    const workerDrained = worker.run();
    const conn = new Connection();
    const client = new WorkflowClient(conn.service, {
      interceptors: {
        calls: [
          () => ({
            async start(input, next) {
              input.headers.set('message', defaultDataConverter.toPayload(message));
              return next(input);
            },
            async signal(input, next) {
              const [decoded] = input.args;
              const encoded = [...(decoded as any as string)].reverse().join('');
              return next({ ...input, args: [encoded] });
            },
            async query(input, next) {
              const result: string = (await next(input)) as any;
              return [...result].reverse().join('');
            },
          }),
        ],
      },
    });
    const wf = client.stub<{
      main(): string;
      signals: { unblock(secret: string): void };
      queries: { getSecret(): string };
    }>('interceptor-example', {
      taskQueue,
    });
    await wf.start();
    await wf.signal.unblock('12345');
    t.is(await wf.query.getSecret(), '12345');
    const result = await wf.result();
    worker.shutdown();
    await workerDrained;
    t.is(result, message);
  });

  test.serial('WorkflowClientCallsInterceptor intercepts terminate and cancel', async (t) => {
    const taskQueue = 'test-interceptor-term-and-cancel';
    const message = uuid4();

    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      logger: new DefaultLogger('DEBUG'),
    });
    const workerDrained = worker.run();
    const conn = new Connection();
    const client = new WorkflowClient(conn.service, {
      interceptors: {
        calls: [
          () => ({
            async terminate(input, next) {
              return next({ ...input, reason: message });
            },
            async cancel(_input, _next) {
              throw new Error('nope');
            },
          }),
        ],
      },
    });

    const wf = client.stub<Sleeper>('sleep', {
      taskQueue,
    });
    await wf.start(999_999_999); // sleep until cancelled or terminated
    await t.throwsAsync(wf.cancel(), {
      instanceOf: Error,
      message: 'nope',
    });
    await wf.terminate();
    await t.throwsAsync(wf.result(), {
      instanceOf: WorkflowExecutionTerminatedError,
      message,
    });

    worker.shutdown();
    await workerDrained;
  });

  test.serial('Workflow continueAsNew can be intercepted', async (t) => {
    const taskQueue = 'test-continue-as-new-interceptor';
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      logger: new DefaultLogger('DEBUG'),
      interceptors: {
        // Includes an interceptor for ContinueAsNew that will throw an error when used with the workflow below
        workflowModules: ['interceptor-example'],
      },
    });
    const client = new WorkflowClient();
    const workerDrained = worker.run();
    const workflow = client.stub<Empty>('continue-as-new-to-different-workflow', {
      taskQueue,
    });
    await t.throwsAsync(workflow.execute(), {
      instanceOf: WorkflowExecutionFailedError,
      message: 'Expected anything other than 1',
    });
    worker.shutdown();
    await workerDrained;
  });
}
