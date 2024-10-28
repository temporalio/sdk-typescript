import { ResourceBasedTunerOptions } from '@temporalio/core-bridge';
import { helpers, makeTestFunction } from './helpers-integration';
import {
  CustomSlotSupplier,
  SlotInfo,
  SlotMarkUsedContext,
  SlotPermit,
  SlotReleaseContext,
  SlotReserveContext,
} from '@temporalio/worker';
import { AbortSignal } from 'node-fetch/externals';

const test = makeTestFunction({ workflowsPath: __filename });

export async function successString(): Promise<string> {
  return 'success';
}

test('Worker can run with resource based tuner', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const resourceBasedTunerOptions: ResourceBasedTunerOptions = {
    targetCpuUsage: 0.6,
    targetMemoryUsage: 0.6,
  };
  const worker = await createWorker({
    tuner: {
      tunerOptions: resourceBasedTunerOptions,
      activityTaskSlotOptions: {
        minimumSlots: 2,
        maximumSlots: 10,
        rampThrottle: 20,
      },
    },
    // FIXME(JWH): Resource Based Tuner does not guarantee that at least one permit would be
    // allocated to a non-sticky pollers, which means the worker may not be able to poll for a
    // WFT from the normal TQ before this test times out. For now, let's completely disable usage
    // of sticky TQ. Rmeove this once https://github.com/temporalio/sdk-core/issues/775 gets fixed.
    maxCachedWorkflows: 0,
  });
  const result = await worker.runUntil(executeWorkflow(successString));
  t.is(result, 'success');
});

test('Worker can run with mixed slot suppliers in tuner', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const resourceBasedTunerOptions: ResourceBasedTunerOptions = {
    targetCpuUsage: 0.5,
    targetMemoryUsage: 0.5,
  };
  const worker = await createWorker({
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
  const result = await worker.runUntil(executeWorkflow(successString));
  t.is(result, 'success');
});

test('Can assume defaults for resource based options', async (t) => {
  const { createWorker } = helpers(t);
  const resourceBasedTunerOptions: ResourceBasedTunerOptions = {
    targetCpuUsage: 0.6,
    targetMemoryUsage: 0.6,
  };

  // With explicit tuner type
  const worker1 = await createWorker({
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
  await worker1.runUntil(Promise.resolve());

  // With mixed slot suppliers
  const worker2 = await createWorker({
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
  await worker2.runUntil(Promise.resolve());

  t.pass();
});

test('Cannot construct worker tuner with multiple different tuner options', async (t) => {
  const { createWorker } = helpers(t);
  const tunerOptions1: ResourceBasedTunerOptions = {
    targetCpuUsage: 0.5,
    targetMemoryUsage: 0.5,
  };
  const tunerOptions2: ResourceBasedTunerOptions = {
    targetCpuUsage: 0.9,
    targetMemoryUsage: 0.9,
  };
  const error = await t.throwsAsync(() =>
    createWorker({
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

class MySS<SI extends SlotInfo> implements CustomSlotSupplier<SI> {
  readonly type = 'custom';

  async reserveSlot(ctx: SlotReserveContext, abortSignal: AbortSignal): Promise<SlotPermit> {
    console.log('reserveSlot: ', ctx.slotType);
    return {};
  }

  tryReserveSlot(ctx: SlotReserveContext): SlotPermit | undefined {
    console.log('tryReserveSlot');
    return {};
  }

  markSlotUsed(slot: SlotMarkUsedContext<SI>): void {}

  releaseSlot(slot: SlotReleaseContext<SI>): void {}
}

test('Custom slot supplier works', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const slotSupplier = new MySS();

  const worker = await createWorker({
    tuner: {
      workflowTaskSlotSupplier: slotSupplier,
      activityTaskSlotSupplier: slotSupplier,
      localActivityTaskSlotSupplier: slotSupplier,
    },
  });
  const result = await worker.runUntil(executeWorkflow(successString));
  t.is(result, 'success');
});
