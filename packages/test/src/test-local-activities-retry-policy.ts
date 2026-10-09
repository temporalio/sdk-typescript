import { Context as ActivityContext } from '@temporalio/activity';
import type { RetryPolicy } from '@temporalio/common';
import { helpers, makeTestFunction } from './helpers-integration';
import { getRetryPolicyFromActivityInfo } from './workflows/local-activities';

const test = makeTestFunction({
  workflowsPath: require.resolve('./workflows/local-activities'),
});

test.serial('retryPolicy is set correctly', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    // Eager activities do not propagate retry policies.
    // See https://github.com/temporalio/temporal/pull/11357.
    maxEagerActivityReservationsPerWorkflowTask: 0,
    activities: {
      async retryPolicy(): Promise<object | undefined> {
        return ActivityContext.current().info.retryPolicy;
      },
    },
  });

  const retryPolicy: RetryPolicy = {
    backoffCoefficient: 1.5,
    initialInterval: 2.0,
    maximumAttempts: 3,
    maximumInterval: 10.0,
    nonRetryableErrorTypes: ['nonRetryableError'],
  };

  await worker.runUntil(async () => {
    t.deepEqual(await executeWorkflow(getRetryPolicyFromActivityInfo, { args: [retryPolicy, true] }), retryPolicy);
    t.deepEqual(await executeWorkflow(getRetryPolicyFromActivityInfo, { args: [retryPolicy, false] }), retryPolicy);
  });
});
