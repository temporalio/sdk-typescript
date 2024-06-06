import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Client } from '@temporalio/client';
import { ResourceBasedTunerOptions } from '@temporalio/core-bridge';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { successString } from './workflows';

if (RUN_INTEGRATION_TESTS) {
  // TODO: Verify can't build resource tuner with multiple different tuner options

  test('Worker can run with resource based tuner', async (t) => {
    const taskQueue = 'test-resource-based';
    const resourceBasedTunerOptions: ResourceBasedTunerOptions = {
      targetCpuUsage: 0.6,
      targetMemoryUsage: 0.6,
    };
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      tuner: {
        tunerOptions: resourceBasedTunerOptions,
        activityTaskSlotOptions: {
          minimumSlots: 2,
          maximumSlots: 10,
          rampThrottle: 20,
        },
      },
    });
    const client = new Client();
    const result = await worker.runUntil(
      client.workflow.execute(successString, {
        workflowId: uuid4(),
        taskQueue,
      })
    );
    t.is(result, 'success');
  });

  test('Worker can run with mixed slot suppliers in tuner', async (t) => {
    const taskQueue = 'test-resource-based-mixed-slots';
    const resourceBasedTunerOptions: ResourceBasedTunerOptions = {
      targetCpuUsage: 0.5,
      targetMemoryUsage: 0.5,
    };
    const worker = await Worker.create({
      ...defaultOptions,
      taskQueue,
      tuner: {
        activityTaskSlotSupplier: {
          type: 'resource-based',
          minimumSlots: 2,
          maximumSlots: 10,
          rampThrottle: 20,
          tunerOptions: resourceBasedTunerOptions,
        },
        workflowTaskSlotSupplier: {
          type: 'fixed-size',
          numSlots: 10,
        },
        localActivityTaskSlotSupplier: {
          type: 'fixed-size',
          numSlots: 10,
        },
      },
    });
    const client = new Client();
    const result = await worker.runUntil(
      client.workflow.execute(successString, {
        workflowId: uuid4(),
        taskQueue,
      })
    );
    t.is(result, 'success');
  });
}
