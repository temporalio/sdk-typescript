import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { WorkflowClient } from '@temporalio/client';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { successString } from './workflows';
import { ResourceBasedTunerOptions } from '@temporalio/core-bridge';

if (RUN_INTEGRATION_TESTS) {
  // TODO: Verify can't build resource tuner with multiple different tuner options

  test('Worker can run with resource based tuner', async (t) => {
    const resourceBasedTunerOptions: ResourceBasedTunerOptions = {
      targetCpuUsage: 0.5,
      targetMemoryUsage: 0.5,
    };
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue: 'test-resource-based',
      tuner: {
        tunerOptions: resourceBasedTunerOptions,
        activityTaskSlotOptions: {
          minimumSlots: 2,
          maximumSlots: 10,
          rampThrottle: 20,
        },
      },
    });
    const client = new WorkflowClient();
    const result = await worker.runUntil(
      client.execute(successString, {
        workflowId: uuid4(),
        taskQueue: 'only-workflows',
      })
    );
    t.is(result, 'success');
  });

  test('Worker can run with mixed slot suppliers in tuner', async (t) => {
    const resourceBasedTunerOptions: ResourceBasedTunerOptions = {
      targetCpuUsage: 0.5,
      targetMemoryUsage: 0.5,
    };
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue: 'test-resource-based',
      tuner: {
        activityTaskSlotSupplier: {
          minimumSlots: 2,
          maximumSlots: 10,
          rampThrottle: 20,
          tunerOptions: resourceBasedTunerOptions,
        },
        workflowTaskSlotSupplier: {
          numSlots: 10,
        },
        localActivityTaskSlotSupplier: {
          numSlots: 10,
        },
      },
    });
    const client = new WorkflowClient();
    const result = await worker.runUntil(
      client.execute(successString, {
        workflowId: uuid4(),
        taskQueue: 'only-workflows',
      })
    );
    t.is(result, 'success');
  });
}
