import asyncRetry from 'async-retry';
import { tsToMs } from '@temporalio/common/lib/time';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  conditionTimeout0,
  issue1423Workflow,
  langFlagsReplayCorrectly,
  setAndClearTimeout,
} from './test-integration-workflows-common';
import { helpers, makeTestFunction } from './helpers-integration';
import { loadHistory, RUN_TIME_SKIPPING_TESTS } from './helpers';

export * from './test-integration-workflows-common';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
});

test('Condition 0 patch sets a timer', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  t.false(await worker.runUntil(executeWorkflow(conditionTimeout0)));
});

// Validate that issue #1423 is fixed in 1.10.3+
test('issue-1423 - 1.10.3+', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker({});
  const conditionResult = await worker.runUntil(async () => {
    return await executeWorkflow(issue1423Workflow, { args: [false] });
  });
  t.is('didnt-throw', conditionResult);
});

// Validate that issue #1423 behavior is maintained in 1.10.2 in replay mode
test('issue-1423 - legacy', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  const conditionResult = await worker.runUntil(async () => {
    return await executeWorkflow(issue1423Workflow, { args: [true] });
  });
  t.is('threw', conditionResult);
});

test("Lang's SDK flags replay correctly", async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({
    activities: {
      noopActivity: () => {},
    },
  });

  const handle = await startWorkflow(langFlagsReplayCorrectly);
  await worker.runUntil(() => handle.result());

  const worker2 = await createWorker();
  // Retry the query to handle transient query timeouts on slow CI runners
  await worker2.runUntil(() =>
    asyncRetry(() => handle.query('__temporal_workflow_metadata'), { retries: 3, minTimeout: 500 })
  );

  // Query would have thrown if the workflow couldn't be replayed correctly
  t.pass();
});

test("Lang's SDK flags - History from before 1.11.0 replays correctly", async (t) => {
  const { runReplayHistory } = helpers(t);
  const hist = await loadHistory('lang_flags_replay_correctly_1_9_3.json');
  await runReplayHistory({}, hist);
  t.pass();
});

// Context: Due to a bug in 1.11.0 and 1.11.1, SDK flags that were set in those versions were not
// persisted to history. To avoid NDEs on histories produced by those releases, we check the Build
// ID for the SDK version number, and retroactively set some flags on these histories.
test("Lang's SDK flags - Flags from 1.11.[01] are retroactively applied on replay", async (t) => {
  const { runReplayHistory } = helpers(t);
  const hist = await loadHistory('lang_flags_replay_correctly_1_11_1.json');
  await runReplayHistory({}, hist);
  t.pass();
});

test("Lang's SDK flags from 1.11.2 are retroactively applied on replay", async (t) => {
  const { runReplayHistory } = helpers(t);
  const hist = await loadHistory('lang_flags_replay_correctly_1_11_2.json');
  await runReplayHistory({}, hist);
  t.pass();
});

if (RUN_TIME_SKIPPING_TESTS) {
  test.serial('setTimeout and clearTimeout - works before and after 1.10.3', async (t) => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const { createWorker, startWorkflow } = helpers(t, env);
    try {
      const worker = await createWorker({
        activities: {
          activitySleep: env.sleep,
        },
      });
      const handle = await startWorkflow(setAndClearTimeout);
      const timerFired: boolean[] = await worker.runUntil(handle.result());

      t.false(timerFired[0]);
      t.true(timerFired[1]);
      t.false(timerFired[2]);
      t.false(timerFired[3]);
      t.true(timerFired[4]);

      const { events } = await handle.fetchHistory();
      const timerStartedEvents = events?.filter((ev) => ev.timerStartedEventAttributes);
      t.is(timerStartedEvents?.length, 5);
      // Durations that ends with 500ms are the ones that were intercepted
      t.is(tsToMs(timerStartedEvents?.[0].timerStartedEventAttributes?.startToFireTimeout), 20_000);
      t.is(tsToMs(timerStartedEvents?.[1].timerStartedEventAttributes?.startToFireTimeout), 21_000);
      t.is(tsToMs(timerStartedEvents?.[2].timerStartedEventAttributes?.startToFireTimeout), 22_000);
      t.is(tsToMs(timerStartedEvents?.[3].timerStartedEventAttributes?.startToFireTimeout), 23_500);
      t.is(tsToMs(timerStartedEvents?.[4].timerStartedEventAttributes?.startToFireTimeout), 24_500);
    } finally {
      await env.teardown();
    }
  });
}
