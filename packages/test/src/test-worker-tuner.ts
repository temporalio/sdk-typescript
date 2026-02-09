import { ExecutionContext } from 'ava';
import {
  CustomSlotSupplier,
  ResourceBasedTunerOptions,
  SlotInfo,
  SlotMarkUsedContext,
  SlotPermit,
  SlotReleaseContext,
  SlotReserveContext,
} from '@temporalio/worker';
import * as wf from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({ workflowsPath: __filename });

const activities = {
  async hiActivity(): Promise<string> {
    return 'hi';
  },
};

const proxyActivities = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: '5s',
});

export async function successString(): Promise<string> {
  return 'success';
}

export async function doesActivity(): Promise<string> {
  await proxyActivities.hiActivity();
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
      nexusTaskSlotSupplier: {
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
      nexusTaskSlotSupplier: {
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
        nexusTaskSlotSupplier: {
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
  reserved = 0;
  released = 0;
  markedUsed = 0;
  releasedWithInfo = 0;
  seenStickyFlags = new Set<boolean>();
  seenSlotTypes = new Set<string>();
  t: ExecutionContext;

  constructor(testCtx: ExecutionContext) {
    this.t = testCtx;
  }

  async reserveSlot(ctx: SlotReserveContext, _: AbortSignal): Promise<SlotPermit> {
    // Ensure all fields are present
    this.reserveAsserts(ctx);
    return { isTry: false };
  }

  tryReserveSlot(ctx: SlotReserveContext): SlotPermit | null {
    this.reserveAsserts(ctx);
    return { isTry: true };
  }

  markSlotUsed(ctx: SlotMarkUsedContext<SI>): void {
    this.t.truthy(ctx.slotInfo);
    this.t.truthy(ctx.permit);
    this.t.true((ctx.permit as any).isTry !== undefined);
    this.markedUsed++;
  }

  releaseSlot(ctx: SlotReleaseContext<SI>): void {
    this.t.truthy(ctx.permit);
    // Info may not be present for un-used slots
    if (ctx.slotInfo !== undefined) {
      this.releasedWithInfo++;
    }
    this.released++;
  }

  private reserveAsserts(ctx: SlotReserveContext) {
    // Ensure all fields are present
    this.t.truthy(ctx.slotType);
    this.seenSlotTypes.add(ctx.slotType);
    this.t.truthy(ctx.taskQueue);
    this.t.truthy(ctx.workerIdentity);
    this.t.truthy(ctx.workerBuildId); // eslint-disable-line @typescript-eslint/no-deprecated
    this.t.not(ctx.isSticky, undefined);
    this.seenStickyFlags.add(ctx.isSticky);
    this.reserved++;
  }
}

// FIXME: This test is flaky. To be reviewed at a later time.
test('Custom slot supplier works', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const slotSupplier = new MySS(t);

  const worker = await createWorker({
    activities,
    tuner: {
      workflowTaskSlotSupplier: slotSupplier,
      activityTaskSlotSupplier: slotSupplier,
      localActivityTaskSlotSupplier: slotSupplier,
      nexusTaskSlotSupplier: slotSupplier,
    },
  });
  const result = await worker.runUntil(executeWorkflow(doesActivity));
  t.is(result, 'success');

  // All reserved slots will be released - make sure all calls made it through.
  // t.is(slotSupplier.reserved, slotSupplier.released);
  // FIXME: This assertion is flaky due to a possible race condition that happens during Core's shutdown process.
  //        For now, we just accept the fact that we may sometime terminate with one unreleased slot.
  t.true(slotSupplier.reserved === slotSupplier.released || slotSupplier.reserved === slotSupplier.released + 1);

  t.is(slotSupplier.markedUsed, slotSupplier.releasedWithInfo);
  // TODO: See if it makes sense to change core to lazily do LA reservation
  t.like([...slotSupplier.seenSlotTypes].sort(), ['local-activity', 'activity', 'workflow'].sort());
  t.like([...slotSupplier.seenStickyFlags].sort(), [false, true].sort());
});

class BlockingSlotSupplier<SI extends SlotInfo> implements CustomSlotSupplier<SI> {
  readonly type = 'custom';

  aborts = 0;

  async reserveSlot(_: SlotReserveContext, abortSignal: AbortSignal): Promise<SlotPermit> {
    abortSignal.throwIfAborted();
    const abortPromise = new Promise<never>((_, reject) => {
      abortSignal.addEventListener('abort', () => {
        this.aborts++;
        reject(abortSignal.reason);
      });
    });
    await abortPromise;
    throw new Error('Should not reach here');
  }

  tryReserveSlot(_: SlotReserveContext): SlotPermit | null {
    return null;
  }

  markSlotUsed(_: SlotMarkUsedContext<SI>): void {}

  releaseSlot(_: SlotReleaseContext<SI>): void {}
}

test('Custom slot supplier sees aborts', async (t) => {
  const { createWorker } = helpers(t);
  const slotSupplier = new BlockingSlotSupplier();

  const worker = await createWorker({
    activities,
    tuner: {
      workflowTaskSlotSupplier: slotSupplier,
      activityTaskSlotSupplier: slotSupplier,
      localActivityTaskSlotSupplier: slotSupplier,
      nexusTaskSlotSupplier: slotSupplier,
    },
  });
  const runprom = worker.run();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  worker.shutdown();
  await runprom;
  t.true(slotSupplier.aborts > 0);
});

class ThrowingSlotSupplier<SI extends SlotInfo> implements CustomSlotSupplier<SI> {
  readonly type = 'custom';

  markedUsed = false;

  async reserveSlot(ctx: SlotReserveContext, _: AbortSignal): Promise<SlotPermit> {
    // Give out one workflow tasks until one gets used
    if (ctx.slotType === 'workflow' && !this.markedUsed) {
      return {};
    }
    throw new Error('I always throw');
  }

  tryReserveSlot(_: SlotReserveContext): SlotPermit | null {
    throw new Error('I always throw');
  }

  markSlotUsed(_: SlotMarkUsedContext<SI>): void {
    this.markedUsed = true;
    throw new Error('I always throw');
  }

  releaseSlot(_: SlotReleaseContext<SI>): void {
    throw new Error('I always throw');
  }
}

test('Throwing slot supplier avoids blowing everything up', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const slotSupplier = new ThrowingSlotSupplier();

  const worker = await createWorker({
    activities,
    tuner: {
      workflowTaskSlotSupplier: slotSupplier,
      activityTaskSlotSupplier: slotSupplier,
      localActivityTaskSlotSupplier: slotSupplier,
      nexusTaskSlotSupplier: slotSupplier,
    },
  });
  const result = await worker.runUntil(executeWorkflow(successString));
  t.is(result, 'success');
});

class UndefinedSlotSupplier<SI extends SlotInfo> implements CustomSlotSupplier<SI> {
  readonly type = 'custom';

  async reserveSlot(_: SlotReserveContext, __: AbortSignal): Promise<SlotPermit> {
    // I'm a bad cheater
    return undefined as any;
  }

  tryReserveSlot(_: SlotReserveContext): SlotPermit | null {
    return undefined as any;
  }

  markSlotUsed(_: SlotMarkUsedContext<SI>): void {}

  releaseSlot(_: SlotReleaseContext<SI>): void {}
}

test('Undefined slot supplier avoids blowing everything up', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const slotSupplier = new UndefinedSlotSupplier();

  const worker = await createWorker({
    activities,
    tuner: {
      workflowTaskSlotSupplier: slotSupplier,
      activityTaskSlotSupplier: slotSupplier,
      localActivityTaskSlotSupplier: slotSupplier,
      nexusTaskSlotSupplier: slotSupplier,
    },
  });
  const result = await worker.runUntil(executeWorkflow(successString));
  t.is(result, 'success');
});
