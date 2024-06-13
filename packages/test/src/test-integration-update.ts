import { status as grpcStatus } from '@grpc/grpc-js';
import { isGrpcServiceError } from '@temporalio/client';
import * as wf from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({ workflowsPath: __filename });

export const update = wf.defineUpdate<string[], [string]>('update');
export const doneUpdate = wf.defineUpdate<void, []>('done-update');

export async function workflowWithUpdates(): Promise<string[]> {
  const state: string[] = [];
  const updateHandler = async (arg: string): Promise<string[]> => {
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

test('Update can be executed via executeUpdate()', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdates);

    const updateResult = await wfHandle.executeUpdate(update, { args: ['1'] });
    t.deepEqual(updateResult, ['1']);

    const doneUpdateResult = await wfHandle.executeUpdate(doneUpdate);
    t.is(doneUpdateResult, undefined);

    const wfResult = await wfHandle.result();
    t.deepEqual(wfResult, ['1', 'done', '$']);
  });
});

test('Update can be executed via startUpdate() and handle.result()', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdates);

    const updateHandle = await wfHandle.startUpdate(update, { args: ['1'] });
    const updateResult = await updateHandle.result();
    t.deepEqual(updateResult, ['1']);

    const doneUpdateHandle = await wfHandle.startUpdate(doneUpdate);
    const doneUpdateResult = await doneUpdateHandle.result();
    t.is(doneUpdateResult, undefined);

    const wfResult = await wfHandle.result();
    t.deepEqual(wfResult, ['1', 'done', '$']);
  });
});

test('Update handle can be created from identifiers and used to obtain result', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const updateId = 'my-update-id';
    const wfHandle = await startWorkflow(workflowWithUpdates);
    const updateHandleFromStartUpdate = await wfHandle.startUpdate(update, { args: ['1'], updateId });

    // Obtain update handle on workflow handle from start update.
    const updateHandle = wfHandle.getUpdateHandle(updateId);
    t.deepEqual(await updateHandle.result(), ['1']);

    // Obtain update handle on manually-created workflow handle with no run id.
    t.truthy(updateHandleFromStartUpdate.workflowRunId);
    const freshWorkflowHandleWithoutRunId = t.context.envLocal.client.workflow.getHandle(wfHandle.workflowId);
    const updateHandle2 = freshWorkflowHandleWithoutRunId.getUpdateHandle(updateId);
    t.deepEqual(await updateHandle2.result(), ['1']);

    // Obtain update handle on manually-created workflow handle with run id.
    const freshWorkflowHandleWithRunId = t.context.envLocal.client.workflow.getHandle(
      wfHandle.workflowId,
      updateHandleFromStartUpdate.workflowRunId
    );
    const updateHandle3 = freshWorkflowHandleWithRunId.getUpdateHandle(updateId);
    t.deepEqual(await updateHandle3.result(), ['1']);

    // Obtain update handle on manually-created workflow handle with incorrect run id.
    const workflowHandleWithIncorrectRunId = t.context.envLocal.client.workflow.getHandle(
      wfHandle.workflowId,
      wf.uuid4()
    );
    const updateHandle4 = workflowHandleWithIncorrectRunId.getUpdateHandle(updateId);
    const err = await t.throwsAsync(updateHandle4.result());
    t.true(isGrpcServiceError(err) && err.code === grpcStatus.NOT_FOUND);
  });
});

const activities = {
  async myActivity(): Promise<number> {
    return 3;
  },
};

const proxyActivities = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: '5s',
});

const updateThatExecutesActivity = wf.defineUpdate<number, [number]>('updateThatExecutesActivity');

export async function workflowWithMultiTaskUpdate(): Promise<void> {
  wf.setHandler(updateThatExecutesActivity, async (arg: number) => {
    return arg + (await proxyActivities.myActivity());
  });
  await wf.condition(() => false);
}

test('Update handler can execute activity', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({ activities });
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithMultiTaskUpdate);
    const result = await wfHandle.executeUpdate(updateThatExecutesActivity, { args: [4] });
    t.is(result, 7);
  });
});

const stringToStringUpdate = wf.defineUpdate<string, [string]>('stringToStringUpdate');

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

test('Update validator can reject when using executeUpdate()', async (t) => {
  const { createWorker, startWorkflow, assertWorkflowUpdateFailed } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdateValidator);
    const result = await wfHandle.executeUpdate(stringToStringUpdate, { args: ['arg'] });
    t.is(result, 'update-result');
    await assertWorkflowUpdateFailed(
      wfHandle.executeUpdate(stringToStringUpdate, { args: ['bad-arg'] }),
      wf.ApplicationFailure,
      'Validation failed'
    );
  });
});

test('Update validator can reject when using handle.result() but handle can be obtained without error', async (t) => {
  const { createWorker, startWorkflow, assertWorkflowUpdateFailed } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdateValidator);
    let updateHandle = await wfHandle.startUpdate(stringToStringUpdate, { args: ['arg'] });
    t.is(await updateHandle.result(), 'update-result');
    updateHandle = await wfHandle.startUpdate(stringToStringUpdate, { args: ['bad-arg'] });
    await assertWorkflowUpdateFailed(updateHandle.result(), wf.ApplicationFailure, 'Validation failed');
  });
});

const syncUpdate = wf.defineUpdate('sync');
const asyncUpdate = wf.defineUpdate('async');

export async function handlerRaisesException(): Promise<void> {
  wf.setHandler(syncUpdate, (): void => {
    throw new wf.ApplicationFailure(`Deliberate ApplicationFailure in handler`);
  });
  wf.setHandler(asyncUpdate, async (): Promise<void> => {
    throw new wf.ApplicationFailure(`Deliberate ApplicationFailure in handler`);
  });
  await wf.condition(() => false);
}

test('Update: ApplicationFailure in handler rejects the update', async (t) => {
  const { createWorker, startWorkflow, assertWorkflowUpdateFailed } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(handlerRaisesException);
    for (const upd of [syncUpdate, asyncUpdate]) {
      await assertWorkflowUpdateFailed(
        wfHandle.executeUpdate(upd),
        wf.ApplicationFailure,
        'Deliberate ApplicationFailure in handler'
      );
    }
    t.pass();
  });
});

test('Update is rejected if there is no handler', async (t) => {
  const { createWorker, startWorkflow, assertWorkflowUpdateFailed } = helpers(t);
  const worker = await createWorker();
  const updateWithoutHandler = wf.defineUpdate<string[], [string]>('updateWithoutHandler');
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdates);
    await assertWorkflowUpdateFailed(
      wfHandle.executeUpdate(updateWithoutHandler, { args: [''] }),
      wf.ApplicationFailure,
      'No registered handler for update: updateWithoutHandler'
    );
  });
});

test('Update sent after workflow completed', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdates);
    await wfHandle.executeUpdate(doneUpdate);
    await wfHandle.result();
    try {
      await wfHandle.executeUpdate(update, { args: ['1'] });
    } catch (err) {
      t.true(err instanceof wf.WorkflowNotFoundError);
      t.is((err as wf.WorkflowNotFoundError).message, 'workflow execution already completed');
    }
  });
});

test('Update id can be assigned and is present on returned handle', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdates);
    const updateHandle = await wfHandle.startUpdate(doneUpdate, { updateId: 'my-update-id' });
    t.is(updateHandle.updateId, 'my-update-id');
  });
});

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

test('Update handler does not see mutations to arguments made by validator', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithMutatingValidator);
    const updateResult = await wfHandle.executeUpdate(updateWithMutableArg, { args: [['1']] });
    t.deepEqual(updateResult, ['1']);
  });
});

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

const stateMutatingUpdate = wf.defineUpdate('stateMutatingUpdate');

export async function setUpdateHandlerAndExit(): Promise<string> {
  let state = 'initial';
  const mutateState = () => void (state = 'mutated-by-update');
  wf.setHandler(stateMutatingUpdate, mutateState);
  // If an Update is present in the first WFT, then the handler should be called
  // before the workflow exits and the workflow return value should reflect its
  // side effects.
  return state;
}

test('Update is always delivered', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const wfHandle = await startWorkflow(setUpdateHandlerAndExit, { startDelay: '10000 days' });

  wfHandle.executeUpdate(stateMutatingUpdate).catch(() => {
    /* ignore */
  });
  const worker = await createWorker();
  await worker.runUntil(async () => {
    // Worker receives activation: [doUpdate, startWorkflow]
    const wfResult = await wfHandle.result();
    t.deepEqual(wfResult, 'mutated-by-update');
  });
});

test('Two Updates in first WFT', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const wfHandle = await startWorkflow(workflowWithUpdates, { startDelay: '10000 days' });

  wfHandle.executeUpdate(update, { args: ['1'] }).catch(() => {
    /* ignore */
  });
  wfHandle.executeUpdate(doneUpdate).catch(() => {
    /* ignore */
  });
  // Race condition: we want the second update to be in the WFT together with
  // the first, so allow some time to ensure that happens.
  await new Promise((res) => setTimeout(res, 500));

  const worker = await createWorker();
  await worker.runUntil(async () => {
    // Worker receives activation: [doUpdate, doUpdate, startWorkflow]. The
    // updates initially lack a handler, are pushed to a buffer, and are
    // executed when their handler is available.
    const wfResult = await wfHandle.result();
    t.deepEqual(wfResult, ['1', 'done', '$']);
  });
});

// The following test would fail if the point at which the Update handler is
// executed differed between first execution and replay (in that case, the
// Update implementation would be violating workflow determinism).
const earlyExecutedUpdate = wf.defineUpdate('earlyExecutedUpdate');
const handlerHasBeenExecutedQuery = wf.defineQuery<boolean>('handlerHasBeenExecutedQuery');
const openGateSignal = wf.defineSignal('openGateSignal');

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

test('Update handler is called at same point during first execution and replay', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  // Start a Workflow and an Update of that Workflow.
  const wfHandle = await startWorkflow(updateReplayTestWorkflow, { startDelay: '10000 days' });
  wfHandle.executeUpdate(earlyExecutedUpdate).catch(() => {
    /* ignore */
  });
  await new Promise((res) => setTimeout(res, 1000));

  // Avoid waiting for sticky execution timeout on worker transition
  const worker1 = await createWorker({ maxCachedWorkflows: 0 });
  // Worker1 advances the workflow beyond the point where the update handler is
  // invoked.
  await worker1.runUntil(async () => {
    // Use a query to wait until the update handler has been executed (the query
    // handler is not set until after the desired point).
    t.true(await wfHandle.query(handlerHasBeenExecutedQuery));
    // The workflow is now waiting for the gate to open.
  });
  // Worker2 does not have the workflow in cache so will replay.
  const worker2 = await createWorker();
  await worker2.runUntil(async () => {
    await wfHandle.signal(openGateSignal);
    const handlerWasExecutedEarly = await wfHandle.result();
    // If the Update handler is invoked at the same point during replay as it
    // was on first execution then this will pass. But if, for example, the
    // handler was invoked during replay _after_ advancing workflow code (which
    // would violate workflow determinism), then this would not pass.
    t.is(handlerWasExecutedEarly, true);
  });
});

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
// @@@SNIPEND

/* Example from WorkflowHandle docstring */
test('Update/Signal/Query example in WorkflowHandle docstrings works', async (t) => {
  const { createWorker, startWorkflow, assertWorkflowFailedError } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(counterWorkflow, { args: [2] });
    await wfHandle.signal(incrementSignal, 2);
    const queryResult = await wfHandle.query(getValueQuery);
    t.is(queryResult, 4);
    const updateResult = await wfHandle.executeUpdate(incrementAndGetValueUpdate, { args: [2] });
    t.is(updateResult, 6);
    const secondUpdateHandle = await wfHandle.startUpdate(incrementAndGetValueUpdate, { args: [2] });
    const secondUpdateResult = await secondUpdateHandle.result();
    t.is(secondUpdateResult, 8);
    await wfHandle.cancel();
    await assertWorkflowFailedError(wfHandle.result(), wf.CancelledFailure);
  });
});
