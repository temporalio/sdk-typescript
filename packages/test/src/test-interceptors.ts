/* eslint @typescript-eslint/no-non-null-assertion: 0 */
/**
 * E2E Tests for the various SDK interceptors.
 * Tests run serially to improve CI reliability..
 * @module
 */

import { WorkflowClient, WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure, TerminatedFailure } from '@temporalio/common';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { defaultPayloadConverter, WorkflowInfo } from '@temporalio/workflow';
import test from 'ava';
import dedent from 'dedent';
import { v4 as uuid4 } from 'uuid';
import { cleanOptionalStackTrace, RUN_INTEGRATION_TESTS } from './helpers';
import { defaultOptions } from './mock-native-worker';
import {
  continueAsNewToDifferentWorkflow,
  interceptorExample,
  internalsInterceptorExample,
  unblockOrCancel,
} from './workflows';
import { getSecretQuery, unblockWithSecretSignal } from './workflows/interceptor-example';

if (RUN_INTEGRATION_TESTS) {
  test.before(() => {
    Runtime.install({ logger: new DefaultLogger('DEBUG') });
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
              const receivedMessage = encoded ? defaultPayloadConverter.fromPayload(encoded) : '';
              return next({ ...input, args: [receivedMessage] });
            },
          }),
        ],
        workflowModules: [require.resolve('./workflows/interceptor-example')],
      },
    });
    const client = new WorkflowClient({
      interceptors: {
        calls: [
          () => ({
            async start(input, next) {
              return next({
                ...input,
                headers: {
                  ...input.headers,
                  message: defaultPayloadConverter.toPayload(message),
                },
              });
            },
            async signalWithStart(input, next) {
              const [decoded] = input.signalArgs;
              const encoded = [...(decoded as any as string)].reverse().join('');
              return next({
                ...input,
                signalArgs: [encoded],
                headers: {
                  ...input.headers,
                  message: defaultPayloadConverter.toPayload(message),
                  marker: defaultPayloadConverter.toPayload(true),
                },
              });
            },
            async signal(input, next) {
              const [decoded] = input.args;
              const encoded = [...(decoded as any as string)].reverse().join('');
              return next({
                ...input,
                args: [encoded],
                headers: {
                  ...input.headers,
                  marker: defaultPayloadConverter.toPayload(true),
                },
              });
            },
            async query(input, next) {
              const result: string = (await next({
                ...input,
                headers: {
                  ...input.headers,
                  marker: defaultPayloadConverter.toPayload(true),
                },
              })) as any;
              return [...result].reverse().join('');
            },
          }),
        ],
      },
    });
    await worker.runUntil(async () => {
      {
        const wf = await client.start(interceptorExample, {
          taskQueue,
          workflowId: uuid4(),
        });
        // Send both signal and query to more consistently repro https://github.com/temporalio/sdk-node/issues/299
        await Promise.all([
          wf.signal(unblockWithSecretSignal, '12345'),
          wf.query(getSecretQuery).then((result) => t.is(result, '12345')),
        ]);
        const result = await wf.result();
        t.is(result, message);
      }
      {
        const wf = await client.signalWithStart(interceptorExample, {
          taskQueue,
          workflowId: uuid4(),
          signal: unblockWithSecretSignal,
          signalArgs: ['12345'],
        });
        const result = await wf.result();
        t.is(result, message);
      }
    });
  });

  test.serial('WorkflowClientCallsInterceptor intercepts terminate and cancel', async (t) => {
    const taskQueue = 'test-interceptor-term-and-cancel';
    const message = uuid4();
    // Use these to coordinate with workflow activation to complete only after termination
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
    });
    const client = new WorkflowClient({
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

    await worker.runUntil(async () => {
      const wf = await client.start(unblockOrCancel, {
        taskQueue,
        workflowId: uuid4(),
      });
      await t.throwsAsync(wf.cancel(), {
        instanceOf: Error,
        message: 'nope',
      });
      await wf.terminate();
      const error = await t.throwsAsync(wf.result(), {
        instanceOf: WorkflowFailedError,
        message,
      });
      if (!(error instanceof WorkflowFailedError)) {
        throw new Error('Unreachable');
      }
      t.true(error.cause instanceof TerminatedFailure);
    });
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
    const err = await worker.runUntil(async () => {
      return (await t.throwsAsync(
        client.execute(continueAsNewToDifferentWorkflow, {
          taskQueue,
          workflowId: uuid4(),
        }),
        {
          instanceOf: WorkflowFailedError,
          message: 'Workflow execution failed',
        }
      )) as WorkflowFailedError;
    });

    if (!(err.cause instanceof ApplicationFailure)) {
      t.fail(`Expected err.cause to be an ApplicationFailure, got ${err.cause}`);
      return;
    }
    t.deepEqual(err.cause.message, 'Expected anything other than 1');
    t.is(
      cleanOptionalStackTrace(err.cause.stack),
      dedent`
      ApplicationFailure: Expected anything other than 1
          at Function.nonRetryable (common/src/failure.ts)
          at Object.continueAsNew (test/src/workflows/interceptor-example.ts)
          at next (internal-workflow-common/src/interceptors.ts)
          at workflow/src/workflow.ts
          at continueAsNewToDifferentWorkflow (test/src/workflows/continue-as-new-to-different-workflow.ts)
    `
    );
    t.is(err.cause.cause, undefined);
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
      sinks: {
        logger: {
          log: {
            fn: (_: WorkflowInfo, event: string): void => {
              events.push(event);
            },
          },
        },
      },
    });
    const client = new WorkflowClient();
    await worker.runUntil(
      client.execute(internalsInterceptorExample, {
        taskQueue,
        workflowId: uuid4(),
      })
    );
    t.deepEqual(events, ['activate: 0', 'concludeActivation: 1', 'activate: 0', 'concludeActivation: 1']);
  });
}
