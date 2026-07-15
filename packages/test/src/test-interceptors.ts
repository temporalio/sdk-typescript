/* eslint @typescript-eslint/no-non-null-assertion: 0 */
/**
 * E2E Tests for the various SDK interceptors.
 * Tests run serially to improve CI reliability..
 * @module
 */

import { randomUUID } from 'crypto';
import test from 'ava';
import dedent from 'dedent';
import { WorkflowClient, WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure, TerminatedFailure } from '@temporalio/common';
import { DefaultLogger, Runtime } from '@temporalio/worker';
import type { WorkflowInfo } from '@temporalio/workflow';
import { defaultPayloadConverter } from '@temporalio/workflow';
import { isBun, cleanOptionalStackTrace, compareStackTrace, RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { defaultOptions } from './mock-native-worker';
import {
  checkDisposeRan,
  conditionWithTimeoutAfterDisposal,
  continueAsNewToDifferentWorkflow,
  initAndResetFlag,
  interceptorExample,
  internalsInterceptorExample,
  successString,
  unblockOrCancel,
} from './workflows';
import { getSecretQuery, unblockWithSecretSignal } from './workflows/interceptor-example';

if (RUN_INTEGRATION_TESTS) {
  test.before(() => {
    Runtime.install({ logger: new DefaultLogger('DEBUG') });
  });

  test.serial('Tracing can be implemented using interceptors', async (t) => {
    const taskQueue = 'test-interceptors';
    const message = randomUUID();

    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      interceptors: {
        activity: [
          () => ({
            inbound: {
              async execute(input, next) {
                const encoded = input.headers.message;
                const receivedMessage = encoded ? defaultPayloadConverter.fromPayload(encoded) : '';
                return next({ ...input, args: [receivedMessage] });
              },
            },
          }),
        ],
        workflowModules: [require.resolve('./workflows/interceptor-example')],
      },
    });
    const client = new WorkflowClient({
      interceptors: [
        {
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
        },
      ],
    });
    await worker.runUntil(async () => {
      {
        const wf = await client.start(interceptorExample, {
          taskQueue,
          workflowId: randomUUID(),
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
          workflowId: randomUUID(),
          signal: unblockWithSecretSignal,
          signalArgs: ['12345'],
        });
        const result = await wf.result();
        t.is(result, message);
      }
    });
  });

  test.serial('(Legacy) WorkflowClientCallsInterceptor intercepts terminate and cancel', async (t) => {
    const taskQueue = 'test-interceptor-term-and-cancel';
    const message = randomUUID();
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
        workflowId: randomUUID(),
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

  test.serial('WorkflowClientInterceptor intercepts terminate and cancel', async (t) => {
    const taskQueue = 'test-interceptor-term-and-cancel';
    const message = randomUUID();
    // Use these to coordinate with workflow activation to complete only after termination
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
    });
    const client = new WorkflowClient({
      interceptors: [
        {
          async terminate(input, next) {
            return next({ ...input, reason: message });
          },
          async cancel(_input, _next) {
            throw new Error('nope');
          },
        },
      ],
    });

    await worker.runUntil(async () => {
      const wf = await client.start(unblockOrCancel, {
        taskQueue,
        workflowId: randomUUID(),
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

  test.serial('WorkflowClientInterceptor intercepts list and fetchHistory', async (t) => {
    const taskQueue = 'test-interceptor-list-and-fetch-history';
    const workflowId = randomUUID();
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
    });
    let listCalls = 0;
    let fetchHistoryCalls = 0;
    const client = new WorkflowClient({
      interceptors: [
        {
          list(input, next) {
            listCalls += 1;
            return next(input);
          },
          async fetchHistory(input, next) {
            fetchHistoryCalls += 1;
            return next(input);
          },
        },
      ],
    });

    await worker.runUntil(async () => {
      await client.execute(successString, {
        taskQueue,
        workflowId,
      });

      const history = await client.getHandle(workflowId).fetchHistory();
      t.true((history.events?.length ?? 0) > 0);
      t.is(fetchHistoryCalls, 1);

      for await (const _ of client.list({ query: `WorkflowId = "${workflowId}"` })) {
        // consume iterator
      }
      t.is(listCalls, 1);
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
          workflowId: randomUUID(),
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

    const cleanedStack = cleanOptionalStackTrace(err.cause.stack)!;
    const expectedStack = isBun
      ? dedent`
        ApplicationFailure: Expected anything other than 1
            at nonRetryable (test/workflow-bundle-$HASH.js)
            at continueAsNew (test/workflow-bundle-$HASH.js)
            at continueAsNewToDifferentWorkflow (test/workflow-bundle-$HASH.js)
      `
      : dedent`
        ApplicationFailure: Expected anything other than 1
            at $CLASS.nonRetryable (common/src/failure.ts)
            at Object.continueAsNew (test/src/workflows/interceptor-example.ts)
            at composedNext (common/src/interceptors.ts)
            at workflow/src/workflow.ts
            at continueAsNewToDifferentWorkflow (test/src/workflows/continue-as-new-to-different-workflow.ts)
      `;
    compareStackTrace(t, cleanedStack, expectedStack);
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
        workflowId: randomUUID(),
      })
    );
    t.deepEqual(events, ['activate: 0', 'concludeActivation: 1', 'activate: 0', 'concludeActivation: 1']);
  });

  test.serial('Internal interceptor disposes in reusable VM', async (t) => {
    const taskQueue = 'test-reusable-vm-internal-interceptor-disposes';
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      interceptors: {
        workflowModules: [require.resolve('./workflows/internal-interceptor-dispose-global')],
      },
    });

    const client = new WorkflowClient();
    await worker.runUntil(async () => {
      const disposeFlagSet = await client.execute(initAndResetFlag, {
        taskQueue,
        workflowId: randomUUID(),
      });
      t.false(disposeFlagSet);
      const disposeFlagSetNow = await client.execute(checkDisposeRan, {
        taskQueue,
        workflowId: randomUUID(),
      });
      t.true(disposeFlagSetNow);
    });
  });

  // Test to trigger GH #1866
  // When `reuseV8Context: true`, dispose() calls disableStorage() which disables the
  // AsyncLocalStorage instance that stores cancellation scope.
  // This causes CancellationScope.current() to return rootScope instead of the correct
  // inner scope for workflows that continue afterward.
  //
  // The bug manifests in condition() with timeout: the finally block calls
  // CancellationScope.current().cancel() to clean up.
  // When storage is disabled, this incorrectly cancels the rootScope, failing the workflow with "Workflow cancelled".
  test.serial('workflow disposal does not break CancellationScope in other workflows in reusable vm', async (t) => {
    const taskQueue = 'test-reusable-vm-disposal-cancellation-scope';
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
    });

    const client = new WorkflowClient();
    const result = await worker.runUntil(async () => {
      // Fill the cache with workflow that complete immediately
      await client.execute(successString, { taskQueue, workflowId: randomUUID() });

      // Start the condition workflow
      const conditionHandle = await client.start(conditionWithTimeoutAfterDisposal, {
        taskQueue,
        workflowId: randomUUID(),
      });

      // Run another workflow to trigger an evictions and disposal() while
      // conditionWithTimeoutAfterDisposal is cached and waiting
      await client.execute(successString, { taskQueue, workflowId: randomUUID() });

      // If dispose incorrectly disables the cancellation scope storage, then it will fail with CancelledFailure: "Workflow cancelled"
      return await conditionHandle.result();
    });
    t.is(result, 'done');
  });
}
