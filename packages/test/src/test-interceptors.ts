/* eslint @typescript-eslint/no-non-null-assertion: 0 */
/**
 * E2E Tests for the various SDK interceptors.
 * Tests run serially to improve CI reliability..
 * @module
 */

import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import dedent from 'dedent';
import { Core, DefaultLogger, Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import {
  Connection,
  WorkflowClient,
  WorkflowExecutionFailedError,
  WorkflowExecutionTerminatedError,
} from '@temporalio/client';
import { defaultDataConverter, WorkflowInfo } from '@temporalio/workflow';
import { defaultOptions } from './mock-native-worker';
import { cleanStackTrace, RUN_INTEGRATION_TESTS } from './helpers';
import {
  interceptorExample,
  internalsInterceptorExample,
  continueAsNewToDifferentWorkflow,
  unblockOrCancel,
} from './workflows';
import { getSecretQuery, unblockWithSecretSignal } from './workflows/interceptor-example';

if (RUN_INTEGRATION_TESTS) {
  test.before(async () => {
    await Core.install({ logger: new DefaultLogger('DEBUG') });
  });

  test.serial('Tracing can be implemented using interceptors', async (t) => {
    const taskQueue = 'test-interceptors';
    const message = uuid4();

    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      interceptors: {
        activityInbound: [
          () => ({
            async execute(input, next) {
              const encoded = input.headers.message;
              const receivedMessage = encoded ? defaultDataConverter.fromPayload(encoded) : '';
              return next({ ...input, args: [receivedMessage] });
            },
          }),
        ],
        workflowModules: [require.resolve('./workflows/interceptor-example')],
      },
    });
    const workerDrained = worker.run();
    const conn = new Connection();
    const client = new WorkflowClient(conn.service, {
      interceptors: {
        calls: [
          () => ({
            async start(input, next) {
              return next({
                ...input,
                headers: {
                  ...input.headers,
                  message: await defaultDataConverter.toPayload(message),
                },
              });
            },
            async signal(input, next) {
              const [decoded] = input.args;
              const encoded = [...(decoded as any as string)].reverse().join('');
              return next({ ...input, args: [encoded] });
            },
            async signalWithStart(input, next) {
              const [decoded] = input.signalArgs;
              const encoded = [...(decoded as any as string)].reverse().join('');
              return next({
                ...input,
                signalArgs: [encoded],
                headers: {
                  ...input.headers,
                  message: await defaultDataConverter.toPayload(message),
                },
              });
            },
            async query(input, next) {
              const result: string = (await next(input)) as any;
              return [...result].reverse().join('');
            },
          }),
        ],
      },
    });
    {
      const wf = client.createWorkflowHandle(interceptorExample, {
        taskQueue,
      });
      await wf.start();
      // Send both signal and query to more consistently repro https://github.com/temporalio/sdk-node/issues/299
      await Promise.all([
        wf.signal(unblockWithSecretSignal, '12345'),
        wf.query(getSecretQuery).then((result) => t.is(result, '12345')),
      ]);
      const result = await wf.result();
      t.is(result, message);
    }
    {
      const wf = client.createWorkflowHandle(interceptorExample, {
        taskQueue,
      });
      await wf.signalWithStart(unblockWithSecretSignal, ['12345'], []);
      const result = await wf.result();
      t.is(result, message);
    }
    worker.shutdown();
    await workerDrained;
  });

  test.serial('WorkflowClientCallsInterceptor intercepts terminate and cancel', async (t) => {
    const taskQueue = 'test-interceptor-term-and-cancel';
    const message = uuid4();
    // Use these to coordinate with workflow activation to complete only after terimnation
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
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

    const wf = client.createWorkflowHandle(unblockOrCancel, {
      taskQueue,
    });
    await wf.start();
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
      interceptors: {
        // Includes an interceptor for ContinueAsNew that will throw an error when used with the workflow below
        workflowModules: [require.resolve('./workflows/interceptor-example')],
      },
    });
    const client = new WorkflowClient();
    const workerDrained = worker.run();
    const workflow = client.createWorkflowHandle(continueAsNewToDifferentWorkflow, {
      taskQueue,
    });
    const err: WorkflowExecutionFailedError = await t.throwsAsync(workflow.execute(), {
      instanceOf: WorkflowExecutionFailedError,
      message: 'Workflow execution failed',
    });
    if (!(err.cause instanceof ApplicationFailure)) {
      t.fail(`Expected err.cause to be an ApplicationFailure, got ${err.cause}`);
      return;
    }
    t.deepEqual(err.cause.message, 'Expected anything other than 1');
    t.is(
      cleanStackTrace(err.cause.stack),
      dedent`
      Error: Expected anything other than 1
          at Object.continueAsNew
          at next
          at eval
          at continueAsNewToDifferentWorkflow
    `
    );
    t.is(err.cause.cause, undefined);
    worker.shutdown();
    await workerDrained;
  });

  test.serial('Internals can be intercepted for observing Workflow state changes', async (t) => {
    const taskQueue = 'test-internals-interceptor';

    const events = Array<string>();
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      interceptors: {
        // Co-exists with the Workflow
        workflowModules: [require.resolve('./workflows/internals-interceptor-example')],
      },
      dependencies: {
        logger: {
          log: {
            fn: (_: WorkflowInfo, event: string): void => {
              events.push(event);
            },
          },
        },
      },
    });
    const workerDrained = worker.run();
    const client = new WorkflowClient();
    const wf = client.createWorkflowHandle(internalsInterceptorExample, {
      taskQueue,
    });
    await wf.execute();

    worker.shutdown();
    await workerDrained;
    t.deepEqual(events, ['activate: 0', 'concludeActivation: 1', 'activate: 0', 'concludeActivation: 1']);
  });
}
