import { v4 as uuid4 } from 'uuid';
import type { TestFn } from 'ava';
import anyTest from 'ava';
import type { ActivityHandle, TypedActivityClient } from '@temporalio/client';
import { ActivityExecutionFailedError, Client, Connection, TerminatedFailure } from '@temporalio/client';
import type { Duration } from '@temporalio/common';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import type { ActivityOptions } from '@temporalio/client/lib/activity-client';
import { activityInfo } from '@temporalio/activity';
import { RUN_INTEGRATION_TESTS, waitUntil, Worker } from './helpers';
import { echo, throwAnError } from './activities';
import { heartbeatCancellationDetailsActivity } from './activities/heartbeat-cancellation-details';

export interface Context {
  worker: Worker;
  client: Client;
  runPromise: Promise<void>;
}

const activities = {
  echo,
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
  scheduleToCloseTimeout: '1 minute' as Duration,
  idReusePolicy: 'ALLOW_DUPLICATE',
};

const test = anyTest as TestFn<Context>;

if (RUN_INTEGRATION_TESTS) {
  test.before(async (t) => {
    const worker = await Worker.create({
      activities,
      taskQueue,
    });
    const runPromise = worker.run();
    // Catch the error here to avoid unhandled rejection
    runPromise.catch((err) => {
      console.error('Caught error while worker was running', err);
    });
    const connection = await Connection.connect();
    t.context = {
      worker,
      runPromise,
      client: new Client({ connection }),
    };
  });

  test.after.always(async (t) => {
    t.context.worker.shutdown();
    await t.context.runPromise;
  });

  test('Get activity result - success', async (t) => {
    const { client } = t.context;
    const activityId = uuid4();
    const handle = await client.activity.start('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
    });
    t.is(await handle.result(), 'hello');
  });

  test('Get activity result - failure', async (t) => {
    const { client } = t.context;
    const activityId = uuid4();
    const handle = await client.activity.start('throwAnError', {
      ...defaultOptions,
      id: activityId,
      args: [true, 'failure'],
    });
    const err = await t.throwsAsync(() => handle.result(), { instanceOf: ActivityExecutionFailedError });
    t.truthy(err);
    t.assert(err!.cause instanceof ApplicationFailure);
    t.is(err!.cause!.message, 'failure');
  });

  test('Execute activity - success', async (t) => {
    const { client } = t.context;
    const activityId = uuid4();
    const result = await client.activity.execute('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
    });
    t.is(result, 'hello');
  });

  test('Execute activity - failure', async (t) => {
    const { client } = t.context;
    const activityId = uuid4();
    const err = await t.throwsAsync(
      () =>
        client.activity.execute('throwAnError', {
          ...defaultOptions,
          id: activityId,
          args: [true, 'failure'],
        }),
      { instanceOf: ActivityExecutionFailedError }
    );
    t.assert(err?.cause instanceof ApplicationFailure);
    t.is(err?.cause?.message, 'failure');
  });

  test('Describe activity from start handle', async (t) => {
    const { client } = t.context;
    const activityId = uuid4();
    const handle = await client.activity.start('echo', {
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
    const { client } = t.context;
    const activityId = uuid4();

    const firstHandle = await client.activity.start('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
    });
    t.truthy(firstHandle.runId);
    await firstHandle.result();

    const secondHandle = await client.activity.start('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
    });
    t.truthy(firstHandle.runId);
    t.assert(firstHandle.runId !== secondHandle.runId);
    await secondHandle.result();

    t.like(await client.activity.getHandle(activityId).describe(), {
      activityId,
      activityRunId: secondHandle.runId,
      activityType: 'echo',
      attempt: 1,
      status: 'COMPLETED',
      taskQueue,
    });
  });

  test('Describe activity from ID and run ID handle', async (t) => {
    const { client } = t.context;
    const activityId = uuid4();

    const firstHandle = await client.activity.start('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
    });
    t.truthy(firstHandle.runId);
    await firstHandle.result();

    const secondHandle = await client.activity.start('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
    });
    t.truthy(firstHandle.runId);
    t.assert(firstHandle.runId !== secondHandle.runId);
    await secondHandle.result();

    t.like(await client.activity.getHandle(activityId, firstHandle.runId).describe(), {
      activityId,
      activityRunId: firstHandle.runId,
      activityType: 'echo',
      attempt: 1,
      status: 'COMPLETED',
      taskQueue,
    });
  });

  test('Cancel activity', async (t) => {
    const { client } = t.context;
    const activityId = uuid4();
    const handle = await client.activity.start('heartbeatCancellationDetailsActivity', {
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
    const { client } = t.context;
    const activityId = uuid4();
    const handle = await client.activity.start('heartbeatCancellationDetailsActivity', {
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

  async function runThreeActivities(client: Client) {
    const firstAndSecondActivityId = uuid4();
    const firstHandle = await client.activity.start('echo', {
      ...defaultOptions,
      id: firstAndSecondActivityId,
      args: ['hello'],
    });
    await firstHandle.result();

    const secondHandle = await client.activity.start('echo', {
      ...defaultOptions,
      id: firstAndSecondActivityId,
      args: ['hello'],
    });
    await secondHandle.result();

    const thirdActivityId = uuid4();
    const thirdHandle = await client.activity.start('echo', {
      ...defaultOptions,
      id: thirdActivityId,
      args: ['hello'],
    });
    await thirdHandle.result();

    return {
      firstAndSecondActivityId,
      thirdActivityId,
      firstRunId: firstHandle.runId,
      secondRunId: secondHandle.runId,
      thirdRunId: thirdHandle.runId,
    };
  }

  test('Count and list activities', async (t) => {
    const { client } = t.context;

    const ids = await runThreeActivities(client);
    const query = `ActivityId='${ids.firstAndSecondActivityId}' OR ActivityId='${ids.thirdActivityId}'`;

    // Visibility has update delay, repeating query until the activity count is as expected
    await waitUntil(async () => {
      const count = await client.activity.count(query);
      return count.count === 3;
    }, 10000);

    const isListed = {
      [ids.firstAndSecondActivityId + ids.firstRunId]: false,
      [ids.firstAndSecondActivityId + ids.secondRunId]: false,
      [ids.thirdActivityId + ids.thirdRunId]: false,
    };

    for await (const info of client.activity.list(query)) {
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
    const { client } = t.context;
    await t.notThrowsAsync(() =>
      client.activity.execute('verifyStandaloneActivityInfo', {
        ...defaultOptions,
        id: uuid4(),
      })
    );
  });

  test('Typed client - start activity', async (t) => {
    const client = t.context.client.activity.typedClient<typeof activities>();
    const activityId = uuid4();
    const handle = await client.start('echo', {
      ...defaultOptions,
      id: activityId,
      args: ['hello'],
    });
    t.is(await handle.result(), 'hello');
  });

  test('Typed client - execute activity', async (t) => {
    const client = t.context.client.activity.typedClient<typeof activities>();
    const activityId = uuid4();
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
      // eslint-disable @typescript-eslint/no-unused-vars
      {
        // OK
        let handle: ActivityHandle<void> = await client.start('noArgsReturnsVoid', { ...options });
        let result: void = await handle.result();
        handle = await client.start('noArgsReturnsVoid', { ...options });
        handle = await client.start('noArgsReturnsVoid', { ...options, args: undefined });
        handle = await client.start('noArgsReturnsVoid', { ...options, args: [] });
        result = await client.execute('noArgsReturnsVoid', { ...options });
        result = await client.execute('noArgsReturnsVoid', { ...options, args: undefined });
        result = await client.execute('noArgsReturnsVoid', { ...options, args: [] });
      }
      {
        const handle: ActivityHandle<void> = await client.start('noArgsReturnsVoid', {
          ...options,
          args: [
            // @ts-expect-error TS2322
            1,
          ],
        });
        const result: void = await client.execute('noArgsReturnsVoid', {
          ...options,
          args: [
            // @ts-expect-error TS2322
            1,
          ],
        });
      }
      {
        const // @ts-expect-error TS2322
          handle // end error
          : ActivityHandle<number> = await client.start('noArgsReturnsVoid', { ...options });

        const // @ts-expect-error TS2322
          result // end error
          : number = await client.execute('noArgsReturnsVoid', { ...options });
      }
      {
        // OK
        let handle: ActivityHandle<number> = await client.start('noArgsReturnsNumber', { ...options });
        let result: number = await handle.result();
        handle = await client.start('noArgsReturnsNumber', { ...options });
        handle = await client.start('noArgsReturnsNumber', { ...options, args: undefined });
        handle = await client.start('noArgsReturnsNumber', { ...options, args: [] });
        result = await client.execute('noArgsReturnsNumber', { ...options });
        result = await client.execute('noArgsReturnsNumber', { ...options, args: undefined });
        result = await client.execute('noArgsReturnsNumber', { ...options, args: [] });
      }
      {
        const // @ts-expect-error TS2322
          handle // end error
          : ActivityHandle<void> = await client.start('noArgsReturnsNumber', { ...options });

        const // @ts-expect-error TS2322
          result // end error
          : void = await client.execute('noArgsReturnsNumber', { ...options });
      }
      {
        const // @ts-expect-error TS2322
          handle // end error
          : ActivityHandle<string> = await client.start('noArgsReturnsNumber', { ...options });

        const // @ts-expect-error TS2322
          result // end error
          : string = await client.execute('noArgsReturnsNumber', { ...options });
      }
      {
        // OK
        const handle: ActivityHandle<number> = await client.start('numberArgReturnsNumber', { ...options, args: [1] });
        let result: number = await handle.result();
        result = await client.execute('numberArgReturnsNumber', { ...options, args: [1] });
      }
      {
        let handle: ActivityHandle<number> = await client.start('numberArgReturnsNumber', {
          ...options,
          args: [
            // @ts-expect-error TS2322
            'a',
          ],
        });
        handle = await client.start('numberArgReturnsNumber', {
          ...options,
          // @ts-expect-error TS2322
          args: [1, 2],
        });
        handle = await client.start('numberArgReturnsNumber', {
          ...options,
          // @ts-expect-error TS2322
          args: [],
        });
        handle = await client.start('numberArgReturnsNumber', {
          ...options,
          // @ts-expect-error TS2322
          args: undefined,
        });
        handle = await client.start(
          'numberArgReturnsNumber',
          // @ts-expect-error TS2322
          {
            ...options,
          }
        );
        let result: number = await client.execute('numberArgReturnsNumber', {
          ...options,
          args: [
            // @ts-expect-error TS2322
            'a',
          ],
        });
        result = await client.execute('numberArgReturnsNumber', {
          ...options,
          // @ts-expect-error TS2322
          args: [1, 2],
        });
        result = await client.execute('numberArgReturnsNumber', {
          ...options,
          // @ts-expect-error TS2322
          args: [],
        });
        result = await client.execute('numberArgReturnsNumber', {
          ...options,
          // @ts-expect-error TS2322
          args: undefined,
        });
        result = await client.execute(
          'numberArgReturnsNumber',
          // @ts-expect-error TS2322
          {
            ...options,
          }
        );
      }
      {
        // OK
        const handle: ActivityHandle<void> = await client.start('stringAndNumberArgsReturnsVoid', {
          ...options,
          args: ['a', 1],
        });
        let result: void = await handle.result();
        result = await client.execute('stringAndNumberArgsReturnsVoid', { ...options, args: ['a', 1] });
      }
      {
        let handle: ActivityHandle<void> = await client.start('stringAndNumberArgsReturnsVoid', {
          ...options,
          args: [
            'a',
            // @ts-expect-error TS2322
            'b',
          ],
        });
        handle = await client.start('stringAndNumberArgsReturnsVoid', {
          ...options,
          args: [
            // @ts-expect-error TS2322
            1,
            // end error
            2,
          ],
        });
        handle = await client.start('stringAndNumberArgsReturnsVoid', {
          ...options,
          args: [
            // @ts-expect-error TS2322
            1,
            // @ts-expect-error TS2322
            'a',
          ],
        });
        let result: void = await client.execute('stringAndNumberArgsReturnsVoid', {
          ...options,
          args: [
            'a',
            // @ts-expect-error TS2322
            'b',
          ],
        });
        result = await client.execute('stringAndNumberArgsReturnsVoid', {
          ...options,
          args: [
            // @ts-expect-error TS2322
            1,
            // end error
            2,
          ],
        });
        result = await client.execute('stringAndNumberArgsReturnsVoid', {
          ...options,
          args: [
            // @ts-expect-error TS2322
            1,
            // @ts-expect-error TS2322
            'a',
          ],
        });
      }
      // eslint-enable @typescript-eslint/no-unused-vars
    };

    t.pass();
  });
}
