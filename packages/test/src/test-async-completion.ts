import anyTest, { TestInterface, ExecutionContext } from 'ava';
import { Observable, Subject, firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { v4 as uuid4 } from 'uuid';
import { Worker } from '@temporalio/worker';
import {
  ActivityCancelledError,
  ActivityNotFoundError,
  AsyncCompletionClient,
  WorkflowClient,
  WorkflowFailedError,
} from '@temporalio/client';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { runAnAsyncActivity } from './workflows';
import { createActivities } from './activities/async-completer';
import { Info } from '@temporalio/activity';
import { rootCause } from '@temporalio/common';
import { isCancellation } from '@temporalio/workflow';

export interface Context {
  worker: Worker;
  workflowClient: WorkflowClient;
  activityStarted$: Observable<Info>;
  asyncCompletionClient: AsyncCompletionClient;
  runPromise: Promise<void>;
}

// Valid server generated token
const NOT_FOUND_TASK_TOKEN = new Uint8Array([
  10, 36, 52, 101, 98, 48, 102, 49, 56, 52, 45, 101, 48, 51, 49, 45, 52, 52, 102, 97, 45, 56, 98, 48, 99, 45, 102, 48,
  50, 55, 100, 48, 53, 53, 98, 101, 100, 99, 18, 36, 99, 55, 56, 55, 102, 55, 97, 102, 45, 50, 51, 99, 52, 45, 52, 56,
  54, 98, 45, 57, 56, 98, 50, 45, 102, 53, 55, 57, 57, 55, 97, 100, 48, 97, 101, 54, 26, 36, 51, 51, 102, 101, 49, 50,
  99, 56, 45, 98, 101, 52, 57, 45, 52, 49, 97, 50, 45, 56, 97, 98, 100, 45, 49, 55, 54, 53, 52, 57, 54, 101, 100, 101,
  57, 101, 32, 5, 40, 1, 50, 1, 49, 66, 13, 99, 111, 109, 112, 108, 101, 116, 101, 65, 115, 121, 110, 99,
]);

const taskQueue = 'async-activity-completion';
const test = anyTest as TestInterface<Context>;

async function activityStarted(t: ExecutionContext<Context>, workflowId: string): Promise<Info> {
  return await firstValueFrom(
    t.context.activityStarted$.pipe(filter((info) => info.workflowExecution.workflowId === workflowId))
  );
}

if (RUN_INTEGRATION_TESTS) {
  test.before(async (t) => {
    const infoSubject = new Subject<Info>();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const worker = await Worker.create({
      workflowsPath: require.resolve('./workflows'),
      activities: createActivities(infoSubject),
      taskQueue,
    });
    const runPromise = worker.run();
    // Catch the error here to avoid unhandled rejection
    runPromise.catch((err) => {
      console.error('Caught error while worker was running', err);
    });
    t.context = {
      worker,
      runPromise,
      activityStarted$: infoSubject,
      workflowClient: new WorkflowClient(),
      asyncCompletionClient: new AsyncCompletionClient(),
    };
  });

  test.after.always(async (t) => {
    t.context.worker.shutdown();
    await t.context.runPromise;
  });

  test('Activity can complete asynchronously', async (t) => {
    const { workflowClient, asyncCompletionClient } = t.context;
    const workflowId = uuid4();
    const handle = await workflowClient.start(runAnAsyncActivity, {
      workflowId,
      taskQueue,
    });

    const info = await activityStarted(t, workflowId);
    await asyncCompletionClient.complete(info.taskToken, 'success');
    t.is(await handle.result(), 'success');
  });

  test('Activity can complete asynchronously by ID', async (t) => {
    const { workflowClient, asyncCompletionClient } = t.context;
    const workflowId = uuid4();
    const handle = await workflowClient.start(runAnAsyncActivity, {
      workflowId,
      taskQueue,
    });

    const info = await activityStarted(t, workflowId);
    await asyncCompletionClient.complete({ workflowId, activityId: info.activityId }, 'success');
    t.is(await handle.result(), 'success');
  });

  test('Non existing activity async completion throws meaningful message', async (t) => {
    await t.throwsAsync(t.context.asyncCompletionClient.complete(NOT_FOUND_TASK_TOKEN, 'success'), {
      instanceOf: ActivityNotFoundError,
    });
  });

  test('Non existing activity async completion by ID throws meaningful message', async (t) => {
    await t.throwsAsync(t.context.asyncCompletionClient.complete({ workflowId: uuid4(), activityId: '1' }, 'success'), {
      instanceOf: ActivityNotFoundError,
    });
  });

  test('Activity can fail asynchronously', async (t) => {
    const { workflowClient, asyncCompletionClient } = t.context;
    const workflowId = uuid4();
    const handle = await workflowClient.start(runAnAsyncActivity, {
      workflowId,
      taskQueue,
    });

    const info = await activityStarted(t, workflowId);
    await asyncCompletionClient.fail(info.taskToken, new Error('failed'));
    const err = (await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;
    t.is(rootCause(err.cause), 'failed');
  });

  test('Activity can fail asynchronously by ID', async (t) => {
    const { workflowClient, asyncCompletionClient } = t.context;
    const workflowId = uuid4();
    const handle = await workflowClient.start(runAnAsyncActivity, {
      workflowId,
      taskQueue,
    });

    const info = await activityStarted(t, workflowId);
    await asyncCompletionClient.fail({ workflowId, activityId: info.activityId }, new Error('failed'));
    const err = (await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;
    t.is(rootCause(err.cause), 'failed');
  });

  test('Non existing activity async failure throws meaningful message', async (t) => {
    await t.throwsAsync(t.context.asyncCompletionClient.fail(NOT_FOUND_TASK_TOKEN, new Error('failure')), {
      instanceOf: ActivityNotFoundError,
    });
  });

  test('Non existing activity async failure by ID throws meaningful message', async (t) => {
    await t.throwsAsync(
      t.context.asyncCompletionClient.fail(
        {
          workflowId: uuid4(),
          activityId: '1',
        },
        new Error('failure')
      ),
      {
        instanceOf: ActivityNotFoundError,
      }
    );
  });

  test('Non existing activity async cancellation throws meaningful message', async (t) => {
    await t.throwsAsync(t.context.asyncCompletionClient.reportCancellation(NOT_FOUND_TASK_TOKEN, 'cancelled'), {
      instanceOf: ActivityNotFoundError,
    });
  });

  test('Non existing activity async cancellation by ID throws meaningful message', async (t) => {
    await t.throwsAsync(
      t.context.asyncCompletionClient.reportCancellation(
        {
          workflowId: uuid4(),
          activityId: '1',
        },
        'cancelled'
      ),
      {
        instanceOf: ActivityNotFoundError,
      }
    );
  });

  test('Activity can heartbeat and get cancelled with AsyncCompletionClient', async (t) => {
    const { workflowClient, asyncCompletionClient } = t.context;
    const workflowId = uuid4();
    const handle = await workflowClient.start(runAnAsyncActivity, {
      workflowId,
      taskQueue,
      args: [true],
    });

    const info = await activityStarted(t, workflowId);
    await t.throwsAsync(
      async () => {
        for (;;) {
          await asyncCompletionClient.heartbeat(info.taskToken, 'details');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
      { instanceOf: ActivityCancelledError }
    );

    await asyncCompletionClient.reportCancellation(info.taskToken, 'cancelled');

    const err = (await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;
    t.true(isCancellation(err.cause));
  });

  test('Activity can heartbeat and get cancelled by ID with AsyncCompletionClient', async (t) => {
    const { workflowClient, asyncCompletionClient } = t.context;
    const workflowId = uuid4();
    const handle = await workflowClient.start(runAnAsyncActivity, {
      workflowId,
      taskQueue,
      args: [true],
    });

    const info = await activityStarted(t, workflowId);
    await t.throwsAsync(
      async () => {
        for (;;) {
          await asyncCompletionClient.heartbeat({ workflowId, activityId: info.activityId }, 'details');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
      { instanceOf: ActivityCancelledError }
    );

    await asyncCompletionClient.reportCancellation({ workflowId, activityId: info.activityId }, 'cancelled');

    const err = (await t.throwsAsync(handle.result(), {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;
    t.true(isCancellation(err.cause));
  });

  test('Non existing activity async heartbeat throws meaningful message', async (t) => {
    await t.throwsAsync(t.context.asyncCompletionClient.heartbeat(NOT_FOUND_TASK_TOKEN, 'details'), {
      instanceOf: ActivityNotFoundError,
    });
  });

  test('Non existing activity async heartbeat by ID throws meaningful message', async (t) => {
    await t.throwsAsync(
      t.context.asyncCompletionClient.heartbeat(
        {
          workflowId: uuid4(),
          activityId: '1',
        },
        'details'
      ),
      {
        instanceOf: ActivityNotFoundError,
      }
    );
  });
}
