/* eslint @typescript-eslint/no-non-null-assertion: 0 */
/**
 * E2E Tests for the various SDK interceptors.
 * Tests run serially to improve CI reliability..
 * @module
 */

import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Worker, DefaultLogger, errors as workerErrors } from '@temporalio/worker';
import { Connection, WorkflowClient, WorkflowStub } from '@temporalio/client';
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
          }),
        ],
      },
    });
    const run = async (cb: (wf: WorkflowStub<Sleeper>, resultPromise: Promise<any>) => Promise<void>) => {
      const wf = client.stub<Sleeper>('sleep', {
        taskQueue,
      });
      await wf.start(999_999_999); // sleep until cancelled or terminated
      await cb(wf, wf.result());
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
    try {
      await workerDrained;
    } catch (err) {
      // There seems to be a race in Core when trying to complete a WF task for the terminated WF
      // see here: https://github.com/temporalio/sdk-node/pull/132/checks?check_run_id=2880955637
      if (!(err instanceof workerErrors.TransportError)) {
        throw err;
      }
    }
  });
}
