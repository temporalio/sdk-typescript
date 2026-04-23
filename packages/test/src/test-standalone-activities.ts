import { v4 as uuid4 } from 'uuid';
import type { TestFn } from 'ava';
import anyTest from 'ava';
import { Client, Connection, TerminatedFailure } from '@temporalio/client';
import type { Duration } from '@temporalio/common';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import type { ActivityOptions } from '@temporalio/client/lib/activity-client';
import { ActivityExecutionFailedError } from '@temporalio/client/lib/activity-client';
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
}
