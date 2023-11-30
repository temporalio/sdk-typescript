import * as wf from '@temporalio/workflow';
import { helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({ workflowsPath: __filename });

// An update with arguments and return value, with which we associate an async
// handler function and a validator.
export const update = wf.defineUpdate<string[], [string]>('update');
// A update that accepts no arguments and returns nothing, with which we
// associate a sync handler function, but no validator.
export const doneUpdate = wf.defineUpdate<void, []>('done-update');

export async function workflowWithUpdates(): Promise<string[]> {
  const state: string[] = [];
  const updateHandler = async (arg: string): Promise<string[]> => {
    state.push(arg);
    if (arg === 'fail-update') {
      throw new wf.ApplicationFailure(`Deliberate ApplicationFailure in handler`);
    }
    return state;
  };
  const doneUpdateHandler = (): void => {
    state.push('done');
  };
  const validator = (arg: string): void => {
    if (arg === 'bad-arg') {
      throw new Error('Validation failed');
    }
  };
  wf.setHandler(update, updateHandler, { validator });
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

test('Update validator can reject when using executeUpdate()', async (t) => {
  const { createWorker, startWorkflow, assertWorkflowUpdateFailed } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdates);
    await assertWorkflowUpdateFailed(
      wfHandle.executeUpdate(update, { args: ['bad-arg'] }),
      wf.ApplicationFailure,
      'Validation failed'
    );
  });
});

test('Update validator can reject when using handle.result() but handle can be obtained without error', async (t) => {
  const { createWorker, startWorkflow, assertWorkflowUpdateFailed } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdates);
    const updateHandle = await wfHandle.startUpdate(update, { args: ['bad-arg'] });
    await assertWorkflowUpdateFailed(updateHandle.result(), wf.ApplicationFailure, 'Validation failed');
  });
});

test('Update: ApplicationFailure in handler rejects the update', async (t) => {
  const { createWorker, startWorkflow, assertWorkflowUpdateFailed } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdates);
    await assertWorkflowUpdateFailed(
      wfHandle.executeUpdate(update, { args: ['fail-update'] }),
      wf.ApplicationFailure,
      'Deliberate ApplicationFailure in handler'
    );
    await wfHandle.executeUpdate(update, { args: ['done'] });
    const wfResult = await wfHandle.result();
    t.deepEqual(wfResult, ['fail-update', 'done', '$']);
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

export async function workflowWithMutatingValidator(): Promise<string[]> {
  const state: string[] = [];
  const updateHandler = async (arg: [string]): Promise<string[]> => {
    state.push(arg[0]);
    return state;
  };
  const doneUpdateHandler = (): void => {
    state.push('done');
  };
  const validator = (arg: [string]): void => {
    arg[0] = 'mutated!';
  };
  wf.setHandler(updateWithMutableArg, updateHandler, { validator });
  wf.setHandler(doneUpdate, doneUpdateHandler);
  await wf.condition(() => state.includes('done'));
  state.push('$');
  return state;
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

// The following tests construct scenarios in which doUpdate jobs are packaged
// together with startWorkflow in the first Activation. We test this because it
// provides test coverage for Update buffering: were it not for the buffering,
// we would attempt to start performing the Update (validate and handle) before
// its handler is set, since sdk-core sorts Update jobs with Signal jobs, i.e.
// ahead of jobs such as startWorkflow and completeActivity that might result in
// a setHandler call. Also note that we do need to make this guarantee to users,
// because a user might know that their Update is in the first WFT, for example
// because they are doing something similar to what this test does to achieve
// that.

// TODO: we currently lack a way to ensure, without race conditions, via SDK
// APIs, that Updates are packaged together with startWorkflow in the first
// Activation. In lieu of a non-racy implementation, the test below does the
// following:
// 1. Client sends and awaits startWorkflow.
// 2. Client sends but does not await executeUpdate.
// 3. Wait for long enough to be confident that the server handled the
//    executeUpdate and is now waiting for the Update to advance to Completed.
// 4. Start the Worker.

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
  const wfHandle = await startWorkflow(setUpdateHandlerAndExit);

  // Race condition: wait long enough for the Update to have been admitted, so
  // that it is in the first WFT, along with startWorkflow.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  wfHandle.executeUpdate(stateMutatingUpdate);
  await new Promise((res) => setTimeout(res, 1000));

  const worker = await createWorker();
  await worker.runUntil(async () => {
    // Worker receives activation: [doUpdate, startWorkflow]
    const wfResult = await wfHandle.result();
    t.deepEqual(wfResult, 'mutated-by-update');
  });
});

test('Two Updates in first WFT', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const wfHandle = await startWorkflow(workflowWithUpdates);

  // Race condition: wait long enough for the Updates to have been admitted, so
  // that they are in the first WFT, along with startWorkflow.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  wfHandle.executeUpdate(update, { args: ['1'] });
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  wfHandle.executeUpdate(doneUpdate);
  await new Promise((res) => setTimeout(res, 1000));

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
  const wfHandle = await startWorkflow(updateReplayTestWorkflow);
  // Race condition: wait long enough for the Update to have been admitted, so
  // that it is in the first WFT, along with startWorkflow.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  wfHandle.executeUpdate(earlyExecutedUpdate);
  await new Promise((res) => setTimeout(res, 1000));

  const worker1 = await createWorker();
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
