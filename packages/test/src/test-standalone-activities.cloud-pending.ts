import { randomUUID } from 'crypto';
import type { ExecutionContext, TestFn } from 'ava';
import anyTest from 'ava';
import * as rxjs from 'rxjs';
import type {
  ActivityHandle,
  ActivityOptions,
  ActivityClientInterceptor,
  TypedActivityClient,
} from '@temporalio/client';
import {
  ActivityExecutionStatus,
  ActivityExecutionAlreadyStartedError,
  ActivityExecutionFailedError,
  Client,
  ServiceError,
  TerminatedFailure,
  isGrpcCancelledError,
} from '@temporalio/client';
import type { Payload, PayloadCodec, PayloadTypeInfo } from '@temporalio/common';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import type { Info } from '@temporalio/activity';
import { activityInfo } from '@temporalio/activity';
import type { TestWorkflowEnvironment } from './helpers';
import { RUN_INTEGRATION_TESTS, waitUntil, Worker } from './helpers';
import { echo, throwAnError } from './activities';
import { heartbeatCancellationDetailsActivity } from './activities/heartbeat-cancellation-details';
import { createTestWorkflowEnvironment } from './helpers-integration';
import { convertOrder, createAsyncOrderActivities } from './workflows/type-info/activities';
import { activityTypeInfo } from './workflows/type-info/activity-type-info';
import { Order, Receipt, receiptTypeInfo } from './workflows/type-info/models';

// Use a reduced server long-poll expiration timeout, in order to confirm that client
// polling/retry strategies result in the expected behavior
const LONG_POLL_TIMEOUT_MS = 5000;

export interface Context {
  env: TestWorkflowEnvironment;
  worker: Worker;
  runPromise: Promise<void>;
  activityStartedSubject: rxjs.Subject<string>;
  activitySignalSubject: rxjs.Subject<string>;
  asyncActivityStartedSubject: rxjs.Subject<Info>;
}

const activities = {
  echo,
  convertOrder,
  throwAnError,
  heartbeatCancellationDetailsActivity,
  verifyStandaloneActivityInfo: async () => {
    const info = activityInfo();
    if (info.inWorkflow) {
      throw ApplicationFailure.nonRetryable('Expected inWorkflow to be false');
    }
    if (!info.activityRunId || info.activityRunId.length === 0) {
      throw ApplicationFailure.nonRetryable('Expected non-empty activityRunId');
    }
    if (info.workflowExecution !== undefined) {
      throw ApplicationFailure.nonRetryable('Expected workflowExecution to be unset');
    }
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    if (info.workflowNamespace !== undefined) {
      throw ApplicationFailure.nonRetryable('Expected workflowNamespace to be unset');
    }
    if (info.workflowType !== undefined) {
      throw ApplicationFailure.nonRetryable('Expected workflowNamespace to be unset');
    }
  },
};

interface ActivityInterface {
  noArgsReturnsVoid: () => Promise<void>;
  numberArgReturnsVoid: (a: number) => Promise<void>;
  stringAndNumberArgsReturnsVoid: (a: string, b: number) => Promise<void>;
  noArgsReturnsNumber: () => Promise<number>;
  numberArgReturnsNumber: (a: number) => Promise<number>;
}

const taskQueue = 'standalone-activities';
const defaultOptions: Omit<ActivityOptions, 'id' | 'args'> = {
  taskQueue,
  scheduleToCloseTimeout: '1 minute',
  idReusePolicy: 'ALLOW_DUPLICATE',
};

const typeInfoActivityOptions = {
  ...defaultOptions,
  retry: { maximumAttempts: 1 },
};

const test = anyTest as TestFn<Context>;

async function waitForValue<T>(subject: rxjs.Subject<T>, value: T) {
  await rxjs.firstValueFrom(subject.pipe(rxjs.first((v) => v === value)));
}

function assertReceipt(t: ExecutionContext, receipt: Receipt): void {
  t.true(receipt instanceof Receipt);
  t.is(receipt.summary(), 'order-1:12345');
  t.is(typeof receipt.totalCents, 'bigint');
}

function makeClientWithActivityInterceptors(
  env: TestWorkflowEnvironment,
  interceptors: ActivityClientInterceptor[]
): Client {
  return new Client({
    connection: env.client.connection,
    namespace: env.client.options.namespace,
    interceptors: { activity: interceptors },
  });
}

class BlockingEncodePayloadCodec implements PayloadCodec {
  readonly encodingStarted: Promise<void>;
  private readonly continueEncoding: Promise<void>;
  private resolveEncodingStarted!: () => void;
  private resolveContinueEncoding!: () => void;
  private blockNextEncode = true;

  constructor() {
    this.encodingStarted = new Promise((resolve) => {
      this.resolveEncodingStarted = resolve;
    });
    this.continueEncoding = new Promise((resolve) => {
      this.resolveContinueEncoding = resolve;
    });
  }

  async encode(payloads: Payload[]): Promise<Payload[]> {
    if (this.blockNextEncode) {
      this.blockNextEncode = false;
      this.resolveEncodingStarted();
      await this.continueEncoding;
    }
    return payloads;
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads;
  }

  releaseEncoding(): void {
    this.resolveContinueEncoding();
  }
}

if (RUN_INTEGRATION_TESTS) {
  test.before(async (t) => {
    const env = await createTestWorkflowEnvironment({
      server: {
        extraArgs: [
          '--dynamic-config-value',
          `activity.longPollTimeout="${LONG_POLL_TIMEOUT_MS}ms"`,
          '--dynamic-config-value',
          'activity.startDelayEnabled=true',
        ],
      },
    });

    const activityStartedSubject = new rxjs.Subject<string>();
    const activitySignalSubject = new rxjs.Subject<string>();
    const asyncActivityStartedSubject = new rxjs.Subject<Info>();

    const worker = await Worker.create({
      activities: {
        ...activities,
        ...createAsyncOrderActivities(asyncActivityStartedSubject),
        waitForSignal: async () => {
          const activityId = activityInfo().activityId;
          const wait = waitForValue(activitySignalSubject, activityId);
          activityStartedSubject.next(activityId);
          await wait;
        },
      },
      taskQueue,
      connection: env.nativeConnection,
    });

    const runPromise = worker.run();
    // Catch the error here to avoid unhandled rejection
    runPromise.catch((err) => {
      console.error('Caught error while worker was running', err);
    });

    t.context = {
      env,
      worker,
      runPromise,
      activityStartedSubject,
      activitySignalSubject,
      asyncActivityStartedSubject,
    };
  });

  test.after.always(async (t) => {
    t.context.worker.shutdown();
    await t.context.runPromise;
    await t.context.env.teardown();
  });

  test('Get activity result - success', async (t) => {
    const client = t.context.env.client.activity;
    const activityId = randomUUID();
    const handle = await client.start('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
    });
    t.is(await handle.result(), 'hello');
    t.is(await client.getHandle(activityId).result(), 'hello');
    t.is(await client.getHandle(activityId, handle.runId).result(), 'hello');
  });

  test('Get activity result - failure', async (t) => {
    const client = t.context.env.client.activity;
    const activityId = randomUUID();
    const handle = await client.start('throwAnError', {
      ...defaultOptions,
      id: activityId,
      args: [true, 'failure'],
    });
    const err = await t.throwsAsync(() => handle.result(), { instanceOf: ActivityExecutionFailedError });
    t.assert(err?.cause instanceof ApplicationFailure);
    t.is(err?.cause?.message, 'failure');
  });

  test('Execute activity - success', async (t) => {
    const client = t.context.env.client.activity;
    const activityId = randomUUID();
    const result = await client.execute('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
    });
    t.is(result, 'hello');
  });

  test('Start Activity preserves rich input and retained result with TypeInfo', async (t) => {
    const client = t.context.env.client.activity;
    const handle = await client.start<Receipt>('convertOrder', {
      ...typeInfoActivityOptions,
      id: randomUUID(),
      args: [new Order('order-1', 12345n)],
      typeInfo: activityTypeInfo.convertOrder,
    });

    assertReceipt(t, await handle.result());
  });

  test('Execute Activity preserves rich input and result with TypeInfo', async (t) => {
    const client = t.context.env.client.activity;
    const result = await client.execute<Receipt>('convertOrder', {
      ...typeInfoActivityOptions,
      id: randomUUID(),
      args: [new Order('order-1', 12345n)],
      typeInfo: activityTypeInfo.convertOrder,
    });

    assertReceipt(t, result);
  });

  test('Async Activity completion by full ID preserves a rich result', async (t) => {
    const client = t.context.env.client.activity;
    const activityStarted = rxjs.firstValueFrom(t.context.asyncActivityStartedSubject);
    const handle = await client.start<Receipt>('completeOrderAsync', {
      ...typeInfoActivityOptions,
      id: randomUUID(),
      args: [new Order('order-1', 12345n)],
      typeInfo: activityTypeInfo.convertOrder,
    });
    const info = await activityStarted;
    await client.complete({ activityId: info.activityId, runId: info.activityRunId }, new Receipt('order-1', 12345n), {
      typeInfo: { outputType: activityTypeInfo.convertOrder.outputType },
    });
    assertReceipt(t, await handle.result());
  });

  test('Detached Activity handles decode results using explicit and definition TypeInfo', async (t) => {
    const client = t.context.env.client.activity;
    const activityId = randomUUID();
    const handle = await client.start<Receipt>('convertOrder', {
      ...typeInfoActivityOptions,
      id: activityId,
      args: [new Order('order-1', 12345n)],
      typeInfo: activityTypeInfo.convertOrder,
    });

    const explicitHandle = client.getHandleWithOptions<Receipt>(activityId, {
      runId: handle.runId,
      typeInfo: { outputType: receiptTypeInfo },
    });
    assertReceipt(t, await explicitHandle.result());

    const definitionHandle = client.getHandleWithOptions(activityId, {
      activity: convertOrder,
      runId: handle.runId,
    });
    assertReceipt(t, await definitionHandle.result());
  });

  test('Activity interceptors can provide input and result TypeInfo', async (t) => {
    const client = makeClientWithActivityInterceptors(t.context.env, [
      {
        async start(input, next) {
          return await next({
            ...input,
            options: {
              ...input.options,
              typeInfo: { inputTypes: activityTypeInfo.convertOrder.inputTypes },
            },
          });
        },
        async getResult(input, next) {
          return await next({
            ...input,
            outputType: activityTypeInfo.convertOrder.outputType,
          });
        },
      },
    ]);

    const result = await client.activity.execute<Receipt>('convertOrder', {
      ...typeInfoActivityOptions,
      id: randomUUID(),
      args: [new Order('order-1', 12345n)],
    });

    assertReceipt(t, result);
  });

  test('Activity start snapshots output TypeInfo before asynchronous encoding', async (t) => {
    const codec = new BlockingEncodePayloadCodec();
    const client = new Client({
      connection: t.context.env.client.connection,
      namespace: t.context.env.client.options.namespace,
      dataConverter: { payloadCodecs: [codec] },
    });
    const typeInfo: PayloadTypeInfo = { ...activityTypeInfo.convertOrder };
    const start = client.activity.start<Receipt>('convertOrder', {
      ...typeInfoActivityOptions,
      id: randomUUID(),
      args: [new Order('order-1', 12345n)],
      typeInfo,
    });

    await codec.encodingStarted;
    typeInfo.outputType = undefined;
    codec.releaseEncoding();

    assertReceipt(t, await (await start).result());
  });

  test('Execute activity - failure', async (t) => {
    const client = t.context.env.client.activity;
    const activityId = randomUUID();
    const err = await t.throwsAsync(
      () =>
        client.execute('throwAnError', {
          ...defaultOptions,
          id: activityId,
          args: [true, 'failure'],
        }),
      { instanceOf: ActivityExecutionFailedError }
    );
    t.assert(err?.cause instanceof ApplicationFailure);
    t.is(err?.cause?.message, 'failure');
  });

  test('Start activity with start delay', async (t) => {
    const client = t.context.env.client.activity;
    const activityId = randomUUID();
    const startDelayMs = 2000;
    const handle = await client.start('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
      startDelay: startDelayMs,
    });

    t.is(await handle.result(), 'hello');

    const description = await handle.describe();
    t.is(description.status, ActivityExecutionStatus.COMPLETED);
    t.truthy(description.scheduleTime);
    t.truthy(description.lastStartedTime);
    t.true(description.lastStartedTime!.getTime() - description.scheduleTime!.getTime() >= startDelayMs - 500);
  });

  test('Describe activity from start handle', async (t) => {
    const client = t.context.env.client.activity;
    const activityId = randomUUID();
    const handle = await client.start('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
    });
    t.truthy(handle.runId);
    await handle.result();

    t.like(await handle.describe(), {
      activityId,
      activityRunId: handle.runId,
      activityType: 'echo',
      attempt: 1,
      status: 'COMPLETED',
      taskQueue,
    });
  });

  test('Describe activity from ID handle', async (t) => {
    const client = t.context.env.client.activity;
    const activityId = randomUUID();

    const firstHandle = await client.start('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
    });
    t.truthy(firstHandle.runId);
    await firstHandle.result();

    const secondHandle = await client.start('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
    });
    t.truthy(firstHandle.runId);
    t.assert(firstHandle.runId !== secondHandle.runId);
    await secondHandle.result();

    t.like(await client.getHandle(activityId).describe(), {
      activityId,
      activityRunId: secondHandle.runId,
      activityType: 'echo',
      attempt: 1,
      status: 'COMPLETED',
      taskQueue,
    });
  });

  test('Describe activity from ID and run ID handle', async (t) => {
    const client = t.context.env.client.activity;
    const activityId = randomUUID();

    const firstHandle = await client.start('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
    });
    t.truthy(firstHandle.runId);
    await firstHandle.result();

    const secondHandle = await client.start('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
    });
    t.truthy(firstHandle.runId);
    t.assert(firstHandle.runId !== secondHandle.runId);
    await secondHandle.result();

    t.like(await client.getHandle(activityId, firstHandle.runId).describe(), {
      activityId,
      activityRunId: firstHandle.runId,
      activityType: 'echo',
      attempt: 1,
      status: 'COMPLETED',
      taskQueue,
    });
  });

  test('Cancel activity', async (t) => {
    const client = t.context.env.client.activity;
    const activityId = randomUUID();
    const handle = await client.start('heartbeatCancellationDetailsActivity', {
      ...defaultOptions,
      id: activityId,
      args: [{ shouldRetry: true }],
    });
    await handle.cancel('test cancellation');

    const err: any = await t.throwsAsync(() => handle.result(), { instanceOf: ActivityExecutionFailedError });
    t.assert(err?.cause instanceof CancelledFailure);

    const description = await handle.describe();
    t.is(description.status, 'CANCELED');
    t.is(description.canceledReason, 'test cancellation');
  });

  test('Terminate activity', async (t) => {
    const client = t.context.env.client.activity;
    const activityId = randomUUID();
    const handle = await client.start('heartbeatCancellationDetailsActivity', {
      ...defaultOptions,
      id: activityId,
      args: [{ shouldRetry: true }],
    });
    await handle.terminate('test termination');

    const err: any = await t.throwsAsync(() => handle.result(), { instanceOf: ActivityExecutionFailedError });
    t.assert(err?.cause instanceof TerminatedFailure);
    t.is(err?.cause?.message, 'test termination');

    const description = await handle.describe();
    t.is(description.status, 'TERMINATED');
  });

  test('Count and list activities', async (t) => {
    const client = t.context.env.client.activity;

    const firstAndSecondActivityId = randomUUID();
    const firstHandle = await client.start('echo', {
      ...defaultOptions,
      id: firstAndSecondActivityId,
      args: ['hello'],
    });
    await firstHandle.result();

    const secondHandle = await client.start('echo', {
      ...defaultOptions,
      id: firstAndSecondActivityId,
      args: ['hello'],
    });
    await secondHandle.result();

    const thirdActivityId = randomUUID();
    const thirdHandle = await client.start('echo', {
      ...defaultOptions,
      id: thirdActivityId,
      args: ['hello'],
    });
    await thirdHandle.result();

    const query = `ActivityId='${firstAndSecondActivityId}' OR ActivityId='${thirdActivityId}'`;

    // Visibility has update delay, repeating query until the activity count is as expected
    await waitUntil(async () => {
      const count = await client.count(query);
      return count.count === 3;
    }, 10000);

    const isListed = {
      [firstAndSecondActivityId + firstHandle.runId]: false,
      [firstAndSecondActivityId + secondHandle.runId]: false,
      [thirdActivityId + thirdHandle.runId]: false,
    };

    for await (const info of client.list(query)) {
      t.is(info.activityType, 'echo');
      t.is(info.taskQueue, taskQueue);

      const id = info.activityId + info.activityRunId;
      t.false(isListed[id]);
      isListed[id] = true;
    }

    for (const id in isListed) {
      t.true(isListed[id]);
    }
  });

  test('Verify standalone activity info', async (t) => {
    const client = t.context.env.client.activity;
    await t.notThrowsAsync(() =>
      client.execute('verifyStandaloneActivityInfo', {
        ...defaultOptions,
        id: randomUUID(),
      })
    );
  });

  test('Throws ActivityExecutionAlreadyExistsError on ID conflict', async (t) => {
    const client = t.context.env.client.activity;
    const activityId = randomUUID();
    const options: ActivityOptions = {
      ...defaultOptions,
      id: activityId,
      idConflictPolicy: 'FAIL',
    };

    const activityStarted = waitForValue(t.context.activityStartedSubject, activityId);
    const handle = await client.start('waitForSignal', options);
    await activityStarted;

    const err = await t.throwsAsync(() => client.start('waitForSignal', options), {
      instanceOf: ActivityExecutionAlreadyStartedError,
    });
    t.is(err?.activityId, activityId);
    t.is(err?.runId, handle.runId);

    t.context.activitySignalSubject.next(activityId);
    await handle.result();
  });

  test('Throws ActivityExecutionAlreadyExistsError on ID reuse', async (t) => {
    const client = t.context.env.client.activity;
    const activityId = randomUUID();
    const options: ActivityOptions = {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
      idReusePolicy: 'REJECT_DUPLICATE',
    };

    const handle = await client.start('echo', options);
    await handle.result();
    const err = await t.throwsAsync(() => client.start('echo', options), {
      instanceOf: ActivityExecutionAlreadyStartedError,
    });
    t.is(err?.activityId, activityId);
    t.is(err?.runId, handle.runId);
  });

  test('Wait for result longer than server long poll timeout', async (t) => {
    const client = t.context.env.client.activity;
    const activityId = randomUUID();
    const handle = await client.start('waitForSignal', {
      ...defaultOptions,
      id: activityId,
    });
    const resultPromise = handle.result();
    setTimeout(() => t.context.activitySignalSubject.next(activityId), LONG_POLL_TIMEOUT_MS * 1.5);
    await resultPromise;
    t.pass();
  });

  test('Cancel waiting for result', async (t) => {
    const client = t.context.env.client.activity;
    const activityId = randomUUID();
    const handle = await client.start('waitForSignal', {
      ...defaultOptions,
      id: activityId,
      scheduleToCloseTimeout: '5s',
    });
    const abortController = new AbortController();
    const resultPromise = client.withAbortSignal(abortController.signal, () => handle.result());
    setTimeout(() => abortController.abort(), LONG_POLL_TIMEOUT_MS * 0.25);
    const err = await t.throwsAsync(() => resultPromise, { instanceOf: ServiceError });
    t.assert(isGrpcCancelledError(err));
    t.context.activitySignalSubject.next(activityId);
  });

  test('Typed client - start activity', async (t) => {
    const client = t.context.env.client.activity.typed<typeof activities>();
    const activityId = randomUUID();
    const handle = await client.start('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
    });
    t.is(await handle.result(), 'hello');
  });

  test('Typed client - execute activity', async (t) => {
    const client = t.context.env.client.activity.typed<typeof activities>();
    const activityId = randomUUID();
    const result = await client.execute('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
    });
    t.is(result, 'hello');
  });

  test('Typed client - type safety', async (t) => {
    const options = {
      ...defaultOptions,
      id: 'ACTIVITY_ID',
    };

    const _ = async (client: TypedActivityClient<ActivityInterface>) => {
      {
        // OK
        let _handle: ActivityHandle<void> = await client.start('noArgsReturnsVoid', { ...options });
        let _result: void = await _handle.result();
        _handle = await client.start('noArgsReturnsVoid', { ...options });
        _handle = await client.start('noArgsReturnsVoid', { ...options, args: undefined });
        _handle = await client.start('noArgsReturnsVoid', { ...options, args: [] });
        _result = await client.execute('noArgsReturnsVoid', { ...options });
        _result = await client.execute('noArgsReturnsVoid', { ...options, args: undefined });
        _result = await client.execute('noArgsReturnsVoid', { ...options, args: [] });
      }
      {
        const _handle: ActivityHandle<void> = await client.start('noArgsReturnsVoid', {
          ...options,
          args: [
            // @ts-expect-error TS2322
            1,
          ],
        });
        const _result: void = await client.execute('noArgsReturnsVoid', {
          ...options,
          args: [
            // @ts-expect-error TS2322
            1,
          ],
        });
      }
      {
        const // @ts-expect-error TS2322
          _handle // end error
          : ActivityHandle<number> = await client.start('noArgsReturnsVoid', { ...options });

        const // @ts-expect-error TS2322
          _result // end error
          : number = await client.execute('noArgsReturnsVoid', { ...options });
      }
      {
        // OK
        let _handle: ActivityHandle<number> = await client.start('noArgsReturnsNumber', { ...options });
        let _result: number = await _handle.result();
        _handle = await client.start('noArgsReturnsNumber', { ...options });
        _handle = await client.start('noArgsReturnsNumber', { ...options, args: undefined });
        _handle = await client.start('noArgsReturnsNumber', { ...options, args: [] });
        _result = await client.execute('noArgsReturnsNumber', { ...options });
        _result = await client.execute('noArgsReturnsNumber', { ...options, args: undefined });
        _result = await client.execute('noArgsReturnsNumber', { ...options, args: [] });
      }
      {
        const // @ts-expect-error TS2322
          _handle // end error
          : ActivityHandle<void> = await client.start('noArgsReturnsNumber', { ...options });

        const // @ts-expect-error TS2322
          _result // end error
          : void = await client.execute('noArgsReturnsNumber', { ...options });
      }
      {
        const // @ts-expect-error TS2322
          _handle // end error
          : ActivityHandle<string> = await client.start('noArgsReturnsNumber', { ...options });

        const // @ts-expect-error TS2322
          _result // end error
          : string = await client.execute('noArgsReturnsNumber', { ...options });
      }
      {
        // OK
        const _handle: ActivityHandle<number> = await client.start('numberArgReturnsNumber', { ...options, args: [1] });
        let _result: number = await _handle.result();
        _result = await client.execute('numberArgReturnsNumber', { ...options, args: [1] });
      }
      {
        let _handle: ActivityHandle<number> = await client.start('numberArgReturnsNumber', {
          ...options,
          args: [
            // @ts-expect-error TS2322
            'a',
          ],
        });
        _handle = await client.start('numberArgReturnsNumber', {
          ...options,
          // @ts-expect-error TS2322
          args: [1, 2],
        });
        _handle = await client.start('numberArgReturnsNumber', {
          ...options,
          // @ts-expect-error TS2322
          args: [],
        });
        _handle = await client.start('numberArgReturnsNumber', {
          ...options,
          // @ts-expect-error TS2322
          args: undefined,
        });
        _handle = await client.start(
          'numberArgReturnsNumber',
          // @ts-expect-error TS2322
          {
            ...options,
          }
        );
        let _result: number = await client.execute('numberArgReturnsNumber', {
          ...options,
          args: [
            // @ts-expect-error TS2322
            'a',
          ],
        });
        _result = await client.execute('numberArgReturnsNumber', {
          ...options,
          // @ts-expect-error TS2322
          args: [1, 2],
        });
        _result = await client.execute('numberArgReturnsNumber', {
          ...options,
          // @ts-expect-error TS2322
          args: [],
        });
        _result = await client.execute('numberArgReturnsNumber', {
          ...options,
          // @ts-expect-error TS2322
          args: undefined,
        });
        _result = await client.execute(
          'numberArgReturnsNumber',
          // @ts-expect-error TS2322
          {
            ...options,
          }
        );
      }
      {
        // OK
        const _handle: ActivityHandle<void> = await client.start('stringAndNumberArgsReturnsVoid', {
          ...options,
          args: ['a', 1],
        });
        let _result: void = await _handle.result();
        _result = await client.execute('stringAndNumberArgsReturnsVoid', { ...options, args: ['a', 1] });
      }
      {
        let _handle: ActivityHandle<void> = await client.start('stringAndNumberArgsReturnsVoid', {
          ...options,
          args: [
            'a',
            // @ts-expect-error TS2322
            'b',
          ],
        });
        _handle = await client.start('stringAndNumberArgsReturnsVoid', {
          ...options,
          args: [
            // @ts-expect-error TS2322
            1,
            // end error
            2,
          ],
        });
        _handle = await client.start('stringAndNumberArgsReturnsVoid', {
          ...options,
          args: [
            // @ts-expect-error TS2322
            1,
            // @ts-expect-error TS2322
            'a',
          ],
        });
        let _result: void = await client.execute('stringAndNumberArgsReturnsVoid', {
          ...options,
          args: [
            'a',
            // @ts-expect-error TS2322
            'b',
          ],
        });
        _result = await client.execute('stringAndNumberArgsReturnsVoid', {
          ...options,
          args: [
            // @ts-expect-error TS2322
            1,
            // end error
            2,
          ],
        });
        _result = await client.execute('stringAndNumberArgsReturnsVoid', {
          ...options,
          args: [
            // @ts-expect-error TS2322
            1,
            // @ts-expect-error TS2322
            'a',
          ],
        });
      }
    };

    t.pass();
  });
}
