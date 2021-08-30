/* eslint @typescript-eslint/no-non-null-assertion: 0 */
/**
 * E2E Tests for the various SDK interceptors.
 * Tests run serially to improve CI reliability..
 * @module
 */

import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import dedent from 'dedent';
import { Worker, DefaultLogger } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import {
  Connection,
  WorkflowClient,
  WorkflowExecutionFailedError,
  WorkflowExecutionTerminatedError,
} from '@temporalio/client';
import { ApplyMode, defaultDataConverter } from '@temporalio/workflow';
import { defaultOptions } from './mock-native-worker';
import { Empty } from './interfaces';
import { cleanStackTrace, RUN_INTEGRATION_TESTS } from './helpers';
import { Deps, workflow } from './workflows/block-with-dependencies';

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
              input.headers.set('message', await defaultDataConverter.toPayload(message));
              return next(input);
            },
            async signal(input, next) {
              const [decoded] = input.args;
              const encoded = [...(decoded as any as string)].reverse().join('');
              return next({ ...input, args: [encoded] });
            },
            async signalWithStart(input, next) {
              input.headers.set('message', await defaultDataConverter.toPayload(message));
              const [decoded] = input.signalArgs;
              const encoded = [...(decoded as any as string)].reverse().join('');
              return next({ ...input, signalArgs: [encoded] });
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
      t.is(result, message);
    }
    {
      const wf = client.stub<{
        main(): string;
        signals: { unblock(secret: string): void };
      }>('interceptor-example', {
        taskQueue,
      });
      await wf.signalWithStart('unblock', ['12345'], []);
      const result = await wf.result();
      t.is(result, message);
    }
    worker.shutdown();
    await workerDrained;
  });

  /**
   * This test also verifies that worker can shutdown when there are outstanding activations.
   * Without blocking the activation as we do here there'd be a race between WF completion and termination.
   */
  test.serial('WorkflowClientCallsInterceptor intercepts terminate and cancel', async (t) => {
    const taskQueue = 'test-interceptor-term-and-cancel';
    const message = uuid4();
    // Use these to coordinate with workflow activation to complete only after terimnation
    let unblockLang = (): void => undefined;
    const unblockLangPromise = new Promise<void>((res) => void (unblockLang = res));
    let setLangIsBlocked = (): void => undefined;
    const langIsBlockedPromise = new Promise<void>((res) => void (setLangIsBlocked = res));

    const worker = await Worker.create<{ dependencies: Deps }>({
      ...defaultOptions,
      taskQueue,
      logger: new DefaultLogger('DEBUG'),
      dependencies: {
        blocker: {
          block: {
            applyMode: ApplyMode.ASYNC,
            fn: () => {
              setLangIsBlocked();
              return unblockLangPromise;
            },
          },
        },
      },
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

    const wf = client.stub<typeof workflow>('block-with-dependencies', {
      taskQueue,
    });
    await wf.start();
    await langIsBlockedPromise;
    await t.throwsAsync(wf.cancel(), {
      instanceOf: Error,
      message: 'nope',
    });
    await wf.terminate();
    await t.throwsAsync(wf.result(), {
      instanceOf: WorkflowExecutionTerminatedError,
      message,
    });
    if (unblockLang !== undefined) unblockLang();

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
          at Object.main
    `
    );
    t.is(err.cause.cause, undefined);
    worker.shutdown();
    await workerDrained;
  });
}
