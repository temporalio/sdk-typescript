/* eslint @typescript-eslint/no-non-null-assertion: 0 */
/**
 * E2E Tests for the various SDK interceptors.
 * Tests run serially to improve CI reliability..
 * @module
 */

import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Worker, DefaultLogger } from '@temporalio/worker';
import { Connection, WorkflowClient } from '@temporalio/client';
import * as errors from '@temporalio/workflow/lib/errors';
import { defaultDataConverter } from '@temporalio/workflow';
import { defaultOptions } from './mock-native-worker';
import { Sleeper } from './interfaces';
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
    const conn = new Connection({
      interceptors: {
        workflowClient: [
          () => ({
            async start(input, next) {
              input.headers.set('message', defaultDataConverter.toPayload(message));
              return next(input);
            },
            async signal(input, next) {
              return next({ ...input, args: ['1234'] });
            },
          }),
        ],
      },
    });
    const wf = conn.workflow<{ main(): string; signals: { unblock(secret: string): void } }>('interceptor-example', {
      taskQueue,
    });
    const resultPromise = wf.start();
    await wf.started;
    await wf.signal.unblock('wrong-secret-to-be-replaced-by-interceptor');
    const result = await resultPromise;
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
    const conn = new Connection({
      interceptors: {
        workflowClient: [
          () => ({
            async terminate(input, next) {
              return next({ ...input, reason: message });
            },
            async signal(input, next) {
              return next({ ...input, args: ['1234'] });
            },
          }),
        ],
      },
    });
    const run = async (cb: (wf: WorkflowClient<Sleeper>, resultPromise: Promise<any>) => Promise<void>) => {
      const wf = conn.workflow<Sleeper>('sleep', {
        taskQueue,
      });
      const resultPromise = wf.start(999_999_999); // sleep until cancelled or terminated
      await wf.started;
      await cb(wf, resultPromise);
    };
    await run(async (wf, resultPromise) => {
      await wf.terminate();
      await t.throwsAsync(resultPromise, {
        instanceOf: errors.WorkflowExecutionTerminatedError,
        message,
      });
    });
    // TODO: Finish once Workflow cancellation is implemented
    // await run(async (wf, resultPromise) => {
    //   await wf.cancel();
    //   await t.throwsAsync(resultPromise, {
    //     instanceOf: errors.WorkflowExecutionCancelledError,
    //     message,
    //   });
    // });
    worker.shutdown();
    await workerDrained;
  });
}
