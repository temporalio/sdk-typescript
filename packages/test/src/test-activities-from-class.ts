import test from 'ava';
import { Worker } from '@temporalio/worker';
import { boundActivities } from '@temporalio/common';
import { WorkflowClient } from '@temporalio/client';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS } from './helpers';
import { runActivityFromClass } from './workflows';
import { ActivitiesWithDependencies } from './activities/with-deps';

if (RUN_INTEGRATION_TESTS) {
  test('Activity class is supported', async (t) => {
    // @@@SNIPSTART nodejs-activity-class-worker-registration
    const activities = boundActivities(new ActivitiesWithDependencies('Hola, '));
    const worker = await Worker.create({ ...defaultOptions, taskQueue: 'activities-from-class', activities });
    // @@@SNIPEND
    const client = new WorkflowClient();
    const runner = client.createWorkflowHandle(runActivityFromClass, {
      taskQueue: 'activities-from-class',
    });
    const runAndShutdown = async () => {
      const result = await runner.execute();
      t.is(result, 'Hola, temporal');
      worker.shutdown();
    };
    await Promise.all([worker.run(), runAndShutdown()]);
  });
}
