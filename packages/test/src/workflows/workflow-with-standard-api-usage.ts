/**
 * Workflow exercising the major @temporalio/workflow API surfaces.
 * Used in test-bundler.ts to validate bundle contents and size.
 * Not intended to be run as a standalone integration test.
 */
import {
  proxyActivities,
  proxyLocalActivities,
  sleep,
  defineSignal,
  defineQuery,
  defineUpdate,
  setHandler,
  condition,
  CancellationScope,
  continueAsNew,
  workflowInfo,
  patched,
  deprecatePatch,
  uuid4,
  upsertSearchAttributes,
  ApplicationFailure,
  ActivityCancellationType,
} from '@temporalio/workflow';

interface MyActivities {
  greet(name: string): Promise<string>;
}

const { greet } = proxyActivities<MyActivities>({
  startToCloseTimeout: '1 minute',
  cancellationType: ActivityCancellationType.TRY_CANCEL,
});

const { greet: greetLocal } = proxyLocalActivities<MyActivities>({
  startToCloseTimeout: '1 minute',
});

const nameSignal = defineSignal<[string]>('name');
const resultQuery = defineQuery<string | undefined>('result');
const uppercaseUpdate = defineUpdate<string, [string]>('uppercase');

export async function workflowWithStandardApiUsage(): Promise<string> {
  let name: string | undefined;

  setHandler(nameSignal, (value: string) => void (name = value));
  setHandler(resultQuery, () => name);
  setHandler(uppercaseUpdate, (value: string) => value.toUpperCase());

  await condition(() => name !== undefined, '10 seconds');

  if (patched('new-logic')) {
    name = await greet(name!);
  } else {
    deprecatePatch('old-logic');
    name = await greetLocal(name!);
  }

  await CancellationScope.nonCancellable(async () => {
    await sleep(1);
  });

  upsertSearchAttributes({ WorkflowId: [workflowInfo().workflowId] });

  const id = uuid4();

  if (workflowInfo().continueAsNewSuggested) {
    await continueAsNew<typeof workflowWithStandardApiUsage>();
  }

  if (name === 'throw') {
    throw ApplicationFailure.nonRetryable('test error');
  }

  return `${id}: ${name}`;
}
