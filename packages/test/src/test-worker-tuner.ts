import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { Client } from '@temporalio/client';
import { ResourceBasedTunerOptions } from '@temporalio/core-bridge';
import { defaultOptions } from './mock-native-worker';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import { successString } from './workflows';

if (RUN_INTEGRATION_TESTS) {
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

  test('Can assume defaults for resource based options', async (t) => {
    const taskQueue = 'test-resource-based';
    const resourceBasedTunerOptions: ResourceBasedTunerOptions = {
      targetCpuUsage: 0.6,
      targetMemoryUsage: 0.6,
    };
    // With explicit tuner type
    await Worker.create({
      ...defaultOptions,
      taskQueue,
      tuner: {
        tunerOptions: resourceBasedTunerOptions,
        activityTaskSlotOptions: {
          minimumSlots: 1,
        },
        localActivityTaskSlotOptions: {
          maximumSlots: 10,
        },
        workflowTaskSlotOptions: {
          rampThrottle: 20,
        },
      },
    });
    // With mixed slot suppliers
    await Worker.create({
      ...defaultOptions,
      taskQueue,
      tuner: {
        activityTaskSlotSupplier: {
          type: 'resource-based',
          tunerOptions: resourceBasedTunerOptions,
          minimumSlots: 3,
        },
        workflowTaskSlotSupplier: {
          type: 'fixed-size',
          numSlots: 40,
        },
        localActivityTaskSlotSupplier: {
          type: 'resource-based',
          tunerOptions: resourceBasedTunerOptions,
          maximumSlots: 50,
        },
      },
    });
    t.pass();
  });

  test('Cannot construct worker tuner with multiple different tuner options', async (t) => {
    const taskQueue = 'test-resource-based-mixed-slots';
    const tunerOptions1: ResourceBasedTunerOptions = {
      targetCpuUsage: 0.5,
      targetMemoryUsage: 0.5,
    };
    const tunerOptions2: ResourceBasedTunerOptions = {
      targetCpuUsage: 0.9,
      targetMemoryUsage: 0.9,
    };
    const error = await t.throwsAsync(() =>
      Worker.create({
        ...defaultOptions,
        taskQueue,
        tuner: {
          activityTaskSlotSupplier: {
            type: 'resource-based',
            tunerOptions: tunerOptions1,
          },
          workflowTaskSlotSupplier: {
            type: 'resource-based',
            tunerOptions: tunerOptions2,
          },
          localActivityTaskSlotSupplier: {
            type: 'fixed-size',
            numSlots: 10,
          },
        },
      })
    );
    t.is(error?.message, 'Cannot construct worker tuner with multiple different tuner options');
  });
}
