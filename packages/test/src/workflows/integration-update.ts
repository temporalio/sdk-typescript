import * as wf from '@temporalio/workflow';

export { signalUpdateOrderingWorkflow } from './signal-update-ordering';
export { signalsActivitiesTimersPromiseOrdering } from './signals-timers-activities-order';

// Use a reduced server long-poll expiration timeout, in order to confirm that client
// polling/retry strategies result in the expected behavior
export const LONG_POLL_EXPIRATION_INTERVAL_MS = 5_000;

export const update = wf.defineUpdate<string[], [string]>('update');

export const doneUpdate = wf.defineUpdate<void, []>('done-update');

export async function workflowWithUpdates(): Promise<string[]> {
  const state: string[] = [];
  const updateHandler = async (arg: string): Promise<string[]> => {
    if (arg === 'wait-for-longer-than-server-long-poll-timeout') {
      await wf.sleep(Math.floor(LONG_POLL_EXPIRATION_INTERVAL_MS * 1.5));
    }
    state.push(arg);
    return state;
  };
  // handlers can be sync
  const doneUpdateHandler = (): void => {
    state.push('done');
  };
  wf.setHandler(update, updateHandler);
  wf.setHandler(doneUpdate, doneUpdateHandler);
  await wf.condition(() => state.includes('done'));
  state.push('$');
  return state;
}

export async function workflowWithArgAndUpdateArg(wfArg: string): Promise<void> {
  const updateHandler = async (updateArg: string): Promise<string[]> => {
    return [wfArg, updateArg];
  };
  wf.setHandler(update, updateHandler);
  await wf.condition(() => false);
}

export const neverReturningUpdate = wf.defineUpdate<string[], [string]>('never-returning-update');

export async function workflowWithNeverReturningUpdate(): Promise<never> {
  const updateHandler = async (): Promise<never> => {
    await new Promise(() => {});
    throw new Error('unreachable');
  };
  wf.setHandler(neverReturningUpdate, updateHandler);
  await new Promise(() => {});
  throw new Error('unreachable');
}

export const activities = {
  async myActivity(): Promise<number> {
    return 3;
  },
};

export const proxyActivities = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: '5s',
});

export const updateThatExecutesActivity = wf.defineUpdate<number, [number]>('updateThatExecutesActivity');

export async function workflowWithMultiTaskUpdate(): Promise<void> {
  wf.setHandler(updateThatExecutesActivity, async (arg: number) => {
    return arg + (await proxyActivities.myActivity());
  });
  await wf.condition(() => false);
}

export const stringToStringUpdate = wf.defineUpdate<string, [string]>('stringToStringUpdate');

export async function workflowWithUpdateValidator(): Promise<void> {
  const updateHandler = async (_: string): Promise<string> => {
    return 'update-result';
  };
  const validator = (arg: string): void => {
    if (arg === 'bad-arg') {
      throw new Error('Validation failed');
    }
  };
  wf.setHandler(stringToStringUpdate, updateHandler, { validator });
  await wf.condition(() => false);
}

export const syncUpdate = wf.defineUpdate('sync');

export const asyncUpdate = wf.defineUpdate('async');

export async function handlerRaisesException(): Promise<void> {
  wf.setHandler(syncUpdate, (): void => {
    throw new wf.ApplicationFailure(`Deliberate ApplicationFailure in handler`);
  });
  wf.setHandler(asyncUpdate, async (): Promise<void> => {
    throw new wf.ApplicationFailure(`Deliberate ApplicationFailure in handler`);
  });
  await wf.condition(() => false);
}

export const updateWithMutableArg = wf.defineUpdate<string[], [[string]]>('updateWithMutableArg');

export async function workflowWithMutatingValidator(): Promise<void> {
  const updateHandler = async (arg: [string]): Promise<string[]> => {
    return arg;
  };
  const validator = (arg: [string]): void => {
    arg[0] = 'mutated!';
  };
  wf.setHandler(updateWithMutableArg, updateHandler, { validator });
  await wf.condition(() => false);
}

// The following tests test dispatch of buffered updates. An update is pushed to
// the buffer if its handler is not available when attempting to handle the
// update. If the handler is subsequently set by a setHandler call during
// processing of the same activation, then the handler is invoked on the
// buffered update . Otherwise, the buffered update is rejected. Hence in order
// to test dispatch of buffered updates, we need to cause the update job to be
// packaged together with another job that will cause the handler to be set
// (e.g. startWorkflow, or completeActivity). This scenario is typically
// encountered in the first WFT, and that is what these tests recreate. They
// start the workflow with startDelay, and then send an update (without waiting
// for the server's response) to ensure that doUpdate and startWorkflow are
// packaged in the same WFT (despite the large startDelay value, the server will
// dispatch a WFT when the update is received).

export const stateMutatingUpdate = wf.defineUpdate('stateMutatingUpdate');

export async function setUpdateHandlerAndExit(): Promise<string> {
  let state = 'initial';
  const mutateState = () => void (state = 'mutated-by-update');
  wf.setHandler(stateMutatingUpdate, mutateState);
  // If an Update is present in the first WFT, then the handler should be called
  // before the workflow exits and the workflow return value should reflect its
  // side effects.
  return state;
}

// The following test would fail if the point at which the Update handler is
// executed differed between first execution and replay (in that case, the
// Update implementation would be violating workflow determinism).
export const earlyExecutedUpdate = wf.defineUpdate('earlyExecutedUpdate');

export const handlerHasBeenExecutedQuery = wf.defineQuery<boolean>('handlerHasBeenExecutedQuery');

export const openGateSignal = wf.defineSignal('openGateSignal');

export async function updateReplayTestWorkflow(): Promise<boolean> {
  let handlerHasBeenExecuted = false;
  wf.setHandler(earlyExecutedUpdate, () => void (handlerHasBeenExecuted = true));
  const handlerWasExecutedEarly = handlerHasBeenExecuted;

  wf.setHandler(handlerHasBeenExecutedQuery, () => handlerHasBeenExecuted);

  let gateOpen = false;
  wf.setHandler(openGateSignal, () => void (gateOpen = true));
  await wf.condition(() => gateOpen);

  return handlerWasExecutedEarly;
}

/* Example from WorkflowHandle docstring */

// @@@SNIPSTART typescript-workflow-update-signal-query-example
export const incrementSignal = wf.defineSignal<[number]>('increment');

export const getValueQuery = wf.defineQuery<number>('getValue');

export const incrementAndGetValueUpdate = wf.defineUpdate<number, [number]>('incrementAndGetValue');

export async function counterWorkflow(initialValue: number): Promise<void> {
  let count = initialValue;
  wf.setHandler(incrementSignal, (arg: number) => {
    count += arg;
  });
  wf.setHandler(getValueQuery, () => count);
  wf.setHandler(incrementAndGetValueUpdate, (arg: number): number => {
    count += arg;
    return count;
  });
  await wf.condition(() => false);
}

export const currentInfoUpdate = wf.defineUpdate<string, []>('current-info-update');

export async function workflowWithCurrentUpdateInfo(): Promise<string[]> {
  const state: Promise<string>[] = [];
  const getUpdateId = async (): Promise<string> => {
    await wf.sleep(10);
    const info = wf.currentUpdateInfo();
    if (info === undefined) {
      throw new Error('No current update info');
    }
    return info.id;
  };
  const updateHandler = async (): Promise<string> => {
    const info = wf.currentUpdateInfo();
    if (info === undefined || info.name !== 'current-info-update') {
      throw new Error(`Invalid current update info in updateHandler: info ${info?.name}`);
    }
    const id = await getUpdateId();
    if (info.id !== id) {
      throw new Error(`Update id changed: before ${info.id} after ${id}`);
    }

    state.push(getUpdateId());
    // Re-fetch and return
    const infoAfter = wf.currentUpdateInfo();
    if (infoAfter === undefined) {
      throw new Error('Invalid current update info in updateHandler - after');
    }
    return infoAfter.id;
  };

  const validator = (): void => {
    const info = wf.currentUpdateInfo();
    if (info === undefined || info.name !== 'current-info-update') {
      throw new Error(`Invalid current update info in validator: info ${info?.name}`);
    }
  };

  wf.setHandler(currentInfoUpdate, updateHandler, { validator });

  if (wf.currentUpdateInfo() !== undefined) {
    throw new Error('Current update info not undefined outside handler');
  }

  await wf.condition(() => state.length === 5);

  if (wf.currentUpdateInfo() !== undefined) {
    throw new Error('Current update info not undefined outside handler - after');
  }

  return await Promise.all(state);
}

export const updateThatShouldFail = wf.defineUpdate('updateThatShouldFail');

export async function workflowThatWillBeCancelled(): Promise<void> {
  wf.setHandler(updateThatShouldFail, async () => {
    await wf.condition(() => false);
  });
  await wf.condition(() => false);
}

export async function canCompleteUpdateAfterWorkflowReturns(fail: boolean = false): Promise<void> {
  let gotUpdate = false;
  let mainReturned = false;

  wf.setHandler(wf.defineUpdate<string>('doneUpdate'), async () => {
    gotUpdate = true;
    await wf.condition(() => mainReturned);
    return 'completed';
  });

  await wf.condition(() => gotUpdate);
  mainReturned = true;
  if (fail) throw wf.ApplicationFailure.nonRetryable('Intentional failure');
}

export const logUpdate = wf.defineUpdate<[string, string], [string]>('log-update');

export async function workflowWithLogInUpdate(): Promise<void> {
  const updateHandler = (msg: string): [string, string] => {
    const updateInfo = wf.currentUpdateInfo();
    if (!updateInfo) {
      throw new Error('expected updateInfo to be defined');
    }
    wf.log.info(msg);
    return [updateInfo.id, updateInfo.name];
  };
  wf.setHandler(logUpdate, updateHandler);
  await wf.condition(() => false);
}
