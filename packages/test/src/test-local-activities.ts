import { ApplicationFailure, defaultPayloadConverter, WorkflowClient, WorkflowFailedError } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import { Worker } from '@temporalio/worker';
import { isCancellation } from '@temporalio/workflow';
import anyTest, { TestInterface } from 'ava';
import { firstValueFrom, Subject } from 'rxjs';
import { v4 as uuid4 } from 'uuid';
import * as activities from './activities';
import { RUN_INTEGRATION_TESTS } from './helpers';
import * as workflows from './workflows/local-activity-testers';

interface Context {
  taskQueue: string;
  client: WorkflowClient;
}

const test = anyTest as TestInterface<Context>;

test.beforeEach(async (t) => {
  const title = t.title.replace('beforeEach hook for ', '');
  const taskQueue = `test-local-activities-${title}`;
  t.context = { client: new WorkflowClient(), taskQueue };
});

async function defaultWorker(taskQueue: string) {
  return await Worker.create({
    taskQueue,
    workflowsPath: require.resolve('./workflows/local-activity-testers'),
    activities,
  });
}

if (RUN_INTEGRATION_TESTS) {
  test('Simple local activity works end to end', async (t) => {
    const { client, taskQueue } = t.context;
    const worker = await defaultWorker(taskQueue);
    await worker.runUntil(async () => {
      const res = await client.execute(workflows.runOneLocalActivity, {
        workflowId: uuid4(),
        taskQueue,
        args: ['hello'],
      });
      t.is(res, 'hello');
    });
  });

  test('Parallel local activities work end to end', async (t) => {
    const { client, taskQueue } = t.context;
    const worker = await defaultWorker(taskQueue);
    await worker.runUntil(async () => {
      const args = ['hey', 'ho', 'lets', 'go'];
      const handle = await client.start(workflows.runParallelLocalActivities, {
        workflowId: uuid4(),
        taskQueue,
        args,
      });
      const res = await handle.result();
      t.deepEqual(res, args);

      // Double check we have all local activity markers in history
      const { history } = await client.workflowService.getWorkflowExecutionHistory({
        namespace: 'default',
        execution: { workflowId: handle.workflowId },
      });
      const markers = history?.events?.filter(
        (ev) => ev.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_MARKER_RECORDED
      );
      t.is(markers?.length, 4);
    });
  });

  test('Local activity error is propagated properly to the Workflow', async (t) => {
    const { client, taskQueue } = t.context;
    const worker = await defaultWorker(taskQueue);
    await worker.runUntil(async () => {
      const err: WorkflowFailedError = await t.throwsAsync(
        client.execute(workflows.throwAnErrorFromLocalActivity, {
          workflowId: uuid4(),
          taskQueue,
          args: ['tesssst'],
        }),
        { instanceOf: WorkflowFailedError }
      );
      t.is(err.cause?.message, 'tesssst');
    });
  });

  test('Local activity cancellation is propagated properly to the Workflow', async (t) => {
    const { client, taskQueue } = t.context;
    const worker = await defaultWorker(taskQueue);
    await worker.runUntil(async () => {
      const err: WorkflowFailedError = await t.throwsAsync(
        client.execute(workflows.cancelALocalActivity, {
          workflowId: uuid4(),
          taskQueue,
          workflowTaskTimeout: '3s',
          args: ['waitForCancellation'],
        }),
        { instanceOf: WorkflowFailedError }
      );
      t.true(isCancellation(err.cause));
      t.is(err.cause?.message, 'Activity cancelled');
    });
  });

  test('Failing local activity can be cancelled', async (t) => {
    const { client, taskQueue } = t.context;
    const worker = await defaultWorker(taskQueue);
    await worker.runUntil(async () => {
      const err: WorkflowFailedError = await t.throwsAsync(
        client.execute(workflows.cancelALocalActivity, {
          workflowId: uuid4(),
          taskQueue,
          workflowTaskTimeout: '3s',
          args: ['throwAnError'],
        }),
        { instanceOf: WorkflowFailedError }
      );
      t.true(isCancellation(err.cause));
      t.is(err.cause?.message, 'Activity cancelled');
    });
  });

  test('Serial local activities (in the same task) work end to end', async (t) => {
    const { client, taskQueue } = t.context;
    const worker = await defaultWorker(taskQueue);
    await worker.runUntil(async () => {
      const handle = await client.start(workflows.runSerialLocalActivities, {
        workflowId: uuid4(),
        taskQueue,
      });
      await handle.result();
      const { history } = await client.workflowService.getWorkflowExecutionHistory({
        namespace: 'default',
        execution: { workflowId: handle.workflowId },
      });
      if (history?.events == null) {
        throw new Error('Expected non null events');
      }
      // Last 3 events before completing the workflow should be MarkerRecorded
      t.truthy(history.events[history.events.length - 2].markerRecordedEventAttributes);
      t.truthy(history.events[history.events.length - 3].markerRecordedEventAttributes);
      t.truthy(history.events[history.events.length - 4].markerRecordedEventAttributes);
    });
  });

  test('Local activity does not retry if error is in nonRetryableErrorTypes', async (t) => {
    const { client, taskQueue } = t.context;
    const worker = await defaultWorker(taskQueue);
    await worker.runUntil(async () => {
      const err: WorkflowFailedError = await t.throwsAsync(
        client.execute(workflows.throwAnExplicitNonRetryableErrorFromLocalActivity, {
          workflowId: uuid4(),
          taskQueue,
          args: ['tesssst'],
        }),
        { instanceOf: WorkflowFailedError }
      );
      t.is(err.cause?.message, 'tesssst');
    });
  });

  test('Local activity can retry once', async (t) => {
    let attempts = 0;
    const { taskQueue, client } = t.context;
    const worker = await Worker.create({
      taskQueue,
      workflowsPath: require.resolve('./workflows/local-activity-testers'),
      activities: {
        // Reimplement here to track number of attempts
        async throwAnError(_: unknown, message: string) {
          attempts++;
          throw new Error(message);
        },
      },
    });

    await worker.runUntil(async () => {
      const err: WorkflowFailedError = await t.throwsAsync(
        client.execute(workflows.throwARetryableErrorWithASingleRetry, {
          workflowId: uuid4(),
          taskQueue,
          args: ['tesssst'],
        }),
        { instanceOf: WorkflowFailedError }
      );
      t.is(err.cause?.message, 'tesssst');
    });
    // Might be more than 2 if workflow task times out (CI I'm looking at you)
    t.true(attempts >= 2);
  });

  test('Local activity backs off with timer', async (t) => {
    let attempts = 0;
    const { client, taskQueue } = t.context;
    const worker = await Worker.create({
      taskQueue,
      workflowsPath: require.resolve('./workflows/local-activity-testers'),
      activities: {
        // Reimplement here to track number of attempts
        async succeedAfterFirstAttempt() {
          attempts++;
          if (attempts === 1) {
            throw new Error('Retry me please');
          }
        },
      },
    });

    await worker.runUntil(async () => {
      const handle = await client.start(workflows.throwAnErrorWithBackoff, {
        workflowId: uuid4(),
        taskQueue,
        workflowTaskTimeout: '3s',
      });
      await handle.result();
      const { history } = await client.workflowService.getWorkflowExecutionHistory({
        namespace: 'default',
        execution: { workflowId: handle.workflowId },
      });
      const timers = history?.events?.filter(
        (ev) => ev.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_TIMER_FIRED
      );
      t.is(timers?.length, 1);

      const markers = history?.events?.filter(
        (ev) => ev.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_MARKER_RECORDED
      );
      t.is(markers?.length, 2);
    });
  });

  test('Local activity can be intercepted', async (t) => {
    const { client, taskQueue } = t.context;
    const worker = await Worker.create({
      taskQueue,
      workflowsPath: require.resolve('./workflows/local-activity-testers'),
      // Interceptors included with workflow implementations
      interceptors: {
        workflowModules: [require.resolve('./workflows/local-activity-testers')],
        activityInbound: [
          () => ({
            async execute(input, next) {
              t.is(defaultPayloadConverter.fromPayload(input.headers.secret), 'shhh');
              return await next(input);
            },
          }),
        ],
      },
      activities,
    });
    await worker.runUntil(async () => {
      const res = await client.execute(workflows.runOneLocalActivity, {
        workflowId: uuid4(),
        taskQueue,
        args: ['message'],
      });
      t.is(res, 'messagemessage');
    });
  });

  // TODO: fix Core shutdown and reenable this test
  test.skip('Worker shutdown while running a local activity completes after completion', async (t) => {
    const { client, taskQueue } = t.context;
    const subj = new Subject<void>();
    const worker = await Worker.create({
      taskQueue,
      activities,
      workflowsPath: require.resolve('./workflows/local-activity-testers'),
      interceptors: {
        workflowModules: [require.resolve('./workflows/local-activity-testers')],
      },
      sinks: {
        test: {
          timerFired: {
            fn() {
              subj.next();
            },
          },
        },
      },
      // Just in case
      shutdownGraceTime: '10s',
    });
    const handle = await client.start(workflows.cancelALocalActivity, {
      workflowId: uuid4(),
      taskQueue,
      workflowTaskTimeout: '3s',
      args: ['waitForCancellation'],
    });
    const p = worker.run();
    await firstValueFrom(subj);
    worker.shutdown();

    const err: WorkflowFailedError = await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
    t.true(isCancellation(err.cause));
    t.is(err.cause?.message, 'Activity cancelled');
    console.log('Waiting for worker to complete shutdown');
    await p;
  });

  test('Local activity fails if not registered on Worker', async (t) => {
    const { client, taskQueue } = t.context;
    const worker = await defaultWorker(taskQueue);
    await worker.runUntil(async () => {
      const err: WorkflowFailedError = await t.throwsAsync(
        client.execute(workflows.runANonExisitingLocalActivity, {
          workflowId: uuid4(),
          taskQueue,
        }),
        { instanceOf: WorkflowFailedError }
      );
      t.true(err.cause instanceof ApplicationFailure && !err.cause.nonRetryable);
      t.truthy(err.cause?.message?.startsWith('Activity function activityNotFound is not registered on this Worker'));
    });
  });
}
