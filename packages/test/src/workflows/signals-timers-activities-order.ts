import * as wf from '@temporalio/workflow';

const aaSignal = wf.defineSignal<[string?]>('aaSignal');
const aaUpdate = wf.defineUpdate<void, [string?]>('aaUpdate');

/**
 * This workflow demonstrates a subtle anomaly in the ordering of async operations in
 * pre-ProcessWfActivationJobsAsSingleBatch, and confirms that ordering is now coherent after
 * introduction of that flag.
 *
 * Assuming the workflow receives the activity completion and timer completion in the same workflow
 * task, both `activityCompleted` and `timerCompleted` will be true once the workflow completes; this
 * is a desirable behavior. However, before 1.11.0, if signal also came in during that same activation,
 * then the workflow would complete with`activityCompleted` and `timerCompleted` both `false`, *even
 * though they really did completed*. The fact that all conditions and microtasks resulting from
 * incoming signals will be settled before any other type of event, while other events will all other
 * type of events will execute interleaved with each other, is something non-obvious to users.
 *
 * This can be a problem in many practical use cases, e.g. notably with some form of Entity workflows
 * (the workflow might CAN with a state that doesn't reflect the fact that some activity task has
 * completed) or saga workflows (workflow may fail to properly undo the activity because if it didn't
 * knew that it had completed).
 *
 * Note that there is no safe and easy way for users to resolve this issue by themselves in pre-1.11.0,
 * and neither would calling `wf.allHandlersFinished()` help.
 */
export async function signalsActivitiesTimersPromiseOrdering(): Promise<boolean[]> {
  let activityCompleted = false;
  let timerCompleted = false;
  let gotSignal = false;
  let gotUpdate = false;

  wf.setHandler(aaSignal, async () => {
    gotSignal = true;
  });

  wf.setHandler(aaUpdate, async () => {
    gotUpdate = true;
  });

  (async () => {
    await wf.sleep(100);
    timerCompleted = true;
  })().catch((_err) => {
    /* ignore */
  });

  (async () => {
    await wf.scheduleActivity('myActivity', [], {
      scheduleToCloseTimeout: '10s',
      taskQueue: `${wf.workflowInfo().taskQueue}-activity`,
    });
    activityCompleted = true;
  })().catch((_err) => {
    /* ignore */
  });

  await wf.condition(() => gotSignal || gotUpdate || timerCompleted || activityCompleted);
  return [gotSignal, gotUpdate, timerCompleted, activityCompleted];
}

/**
 * This workflow demonstrates the same anomaly as the `conditionsActivitiesTimersPromiseOrdering`
 * workflow above, but provides a trace of the order of events, making it more suitable for debugging.
 */
export async function signalsActivitiesTimersPromiseOrderingTracer(): Promise<string[]> {
  const events: string[] = [];

  wf.setHandler(aaSignal, async (s?: string) => {
    // Signal handlers, compared to activities and timers, get a first chance to run code
    // synchronously; that plus the fact that they are always processed before any other
    // type of event, means that these signal handlers will each get to push two entries to
    // `events` before any other event gets to push their first event. This is a bit
    // surprising, but totally correct given the current execution model.
    events.push(`${s}.sync`);
    await Promise.resolve();

    events.push(`${s}.1`);
    await Promise.resolve();
    events.push(`${s}.2`);

    await wf.condition(() => true);
    events.push(`${s}.3`);
    await Promise.resolve();
    events.push(`${s}.4`);
  });

  wf.setHandler(aaUpdate, async (s?: string) => {
    // Similar as signal handlers; see comment above.
    events.push(`${s}.sync`);
    await Promise.resolve();

    events.push(`${s}.1`);
    await Promise.resolve();
    events.push(`${s}.2`);

    await wf.condition(() => true);
    events.push(`${s}.3`);
    await Promise.resolve();
    events.push(`${s}.4`);
  });

  const timer = (async () => {
    await wf.sleep(1);

    events.push(`timer.1`);
    await Promise.resolve();
    events.push(`timer.2`);

    await wf.condition(() => true);
    events.push(`timer.3`);
    await Promise.resolve();
    events.push(`timer.4`);
  })();

  const activity = (async () => {
    await wf.scheduleActivity('myActivity', [], { scheduleToCloseTimeout: '1s' });

    events.push(`activity.1`);
    await Promise.resolve();
    events.push(`activity.2`);

    await wf.condition(() => true);
    events.push(`activity.3`);
    await Promise.resolve();
    events.push(`activity.4`);
  })();

  await Promise.all([timer, activity]);
  return events;
}
