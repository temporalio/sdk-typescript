import { randomUUID } from 'crypto';
import { status as grpcStatus } from '@grpc/grpc-js';
import {
  isGrpcServiceError,
  WorkflowUpdateStage,
  WorkflowUpdateRPCTimeoutOrCancelledError,
  WorkflowFailedError,
  WithStartWorkflowOperation,
  WorkflowExecutionAlreadyStartedError,
} from '@temporalio/client';
import * as wf from '@temporalio/workflow';
import { temporal } from '@temporalio/proto';
import { LogEntry } from '@temporalio/worker';
import { helpers, makeTestFunction } from './helpers-integration';
import { signalUpdateOrderingWorkflow } from './workflows/signal-update-ordering';
import { signalsActivitiesTimersPromiseOrdering } from './workflows/signals-timers-activities-order';
import { loadHistory, waitUntil } from './helpers';

// Use a reduced server long-poll expiration timeout, in order to confirm that client
// polling/retry strategies result in the expected behavior
const LONG_POLL_EXPIRATION_INTERVAL_SECONDS = 5.0;

const recordedLogs: { [workflowId: string]: LogEntry[] } = {};

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowEnvironmentOpts: {
    server: {
      extraArgs: [
        '--dynamic-config-value',
        `history.longPollExpirationInterval="${LONG_POLL_EXPIRATION_INTERVAL_SECONDS}s"`,
      ],
    },
  },
  recordedLogs,
});

export const update = wf.defineUpdate<string[], [string]>('update');
export const doneUpdate = wf.defineUpdate<void, []>('done-update');

export async function workflowWithUpdates(): Promise<string[]> {
  const state: string[] = [];
  const updateHandler = async (arg: string): Promise<string[]> => {
    if (arg === 'wait-for-longer-than-server-long-poll-timeout') {
      await wf.sleep(LONG_POLL_EXPIRATION_INTERVAL_SECONDS * 1500);
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

test('updateWithStart happy path', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const startOp = new WithStartWorkflowOperation(workflowWithUpdates, {
      workflowId: randomUUID(),
      taskQueue,
      workflowIdConflictPolicy: 'USE_EXISTING',
    });
    // Can send Update-With-Start MultiOperation request
    const updHandle = await t.context.env.client.workflow.startUpdateWithStart(update, {
      args: ['1'],
      waitForStage: 'ACCEPTED',
      startWorkflowOperation: startOp,
    });
    // Can use returned upate handle to wait for update result
    const updResult1 = await updHandle.result();
    t.deepEqual(updResult1, ['1']);

    // startOp has been mutated such that workflow handle is now available and
    // can be used to interact with the workflow.
    const wfHandle = await startOp.workflowHandle();
    const updResult2 = await wfHandle.executeUpdate(update, { args: ['2'] });
    t.deepEqual(updResult2, ['1', '2']);

    // startOp cannot be re-used in a second Update-With-Start call
    const err = await t.throwsAsync(
      t.context.env.client.workflow.executeUpdateWithStart(update, {
        args: ['3'],
        startWorkflowOperation: startOp,
      })
    );
    t.true(err?.message.includes('WithStartWorkflowOperation instance has already been executed'));
  });
});

export async function workflowWithArgAndUpdateArg(wfArg: string): Promise<void> {
  const updateHandler = async (updateArg: string): Promise<string[]> => {
    return [wfArg, updateArg];
  };
  wf.setHandler(update, updateHandler);
  await wf.condition(() => false);
}

test('updateWithStart can send workflow arg and update arg', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const startOp = new WithStartWorkflowOperation(workflowWithArgAndUpdateArg, {
      workflowId: randomUUID(),
      args: ['wf-arg'],
      taskQueue,
      workflowIdConflictPolicy: 'USE_EXISTING',
    });
    const updResult = await t.context.env.client.workflow.executeUpdateWithStart(update, {
      args: ['upd-arg'],
      startWorkflowOperation: startOp,
    });
    t.deepEqual(updResult, ['wf-arg', 'upd-arg']);
    t.deepEqual((await startOp.workflowHandle()).workflowId, startOp.options.workflowId);
  });
});

test('updateWithStart handles can be obtained concurrently', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const startOp = new WithStartWorkflowOperation(workflowWithUpdates, {
      workflowId: randomUUID(),
      taskQueue,
      workflowIdConflictPolicy: 'USE_EXISTING',
    });
    const [wfHandle, updHandle] = await Promise.all([
      startOp.workflowHandle(),
      t.context.env.client.workflow.startUpdateWithStart(update, {
        args: ['1'],
        waitForStage: 'ACCEPTED',
        startWorkflowOperation: startOp,
      }),
    ]);

    // Can use returned handles
    t.deepEqual(await updHandle.result(), ['1']);
    t.deepEqual(await wfHandle.executeUpdate(update, { args: ['2'] }), ['1', '2']);
  });
});

test('updateWithStart failure: invalid argument', async (t) => {
  const startOp = new WithStartWorkflowOperation(workflowWithUpdates, {
    workflowId: randomUUID().repeat(77),
    taskQueue: 'does-not-exist',
    workflowIdConflictPolicy: 'FAIL',
  });

  for (const promise of [
    t.context.env.client.workflow.startUpdateWithStart(update, {
      args: ['1'],
      waitForStage: 'ACCEPTED',
      startWorkflowOperation: startOp,
    }),
    startOp.workflowHandle(),
  ]) {
    const err = await t.throwsAsync(promise);
    t.true(isGrpcServiceError(err) && err.code === grpcStatus.INVALID_ARGUMENT);
    t.true(err?.message.startsWith('WorkflowId length exceeds limit.'));
  }
});

test('updateWithStart failure: workflow already exists', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
  const workflowId = randomUUID();
  const worker = await createWorker();
  const makeStartOp = () =>
    new WithStartWorkflowOperation(workflowWithUpdates, {
      workflowId,
      taskQueue,
      workflowIdConflictPolicy: 'FAIL',
    });

  const startUpdateWithStart = async (startOp: WithStartWorkflowOperation<typeof workflowWithUpdates>) => {
    return [
      await t.context.env.client.workflow.startUpdateWithStart(update, {
        args: ['1'],
        waitForStage: 'ACCEPTED',
        startWorkflowOperation: startOp,
      }),
      startOp,
    ];
  };
  // The second call should fail with an ALREADY_EXISTS error. We assert that
  // the resulting gRPC error has been correctly constructed from the two errors
  // (start error, and aborted update) returned in the MultiOperationExecutionFailure.
  await worker.runUntil(async () => {
    const startOp1 = makeStartOp();
    await startUpdateWithStart(startOp1);

    const startOp2 = makeStartOp();
    for (const promise of [startUpdateWithStart(startOp2), startOp2.workflowHandle()]) {
      await t.throwsAsync(promise, {
        instanceOf: WorkflowExecutionAlreadyStartedError,
        message: 'Workflow execution already started',
      });
    }
  });
});

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

test('updateWithStart failure: update fails early due to limit on number of updates', async (t) => {
  const workflowId = randomUUID();
  const { createWorker, taskQueue } = helpers(t);
  const worker = await createWorker();
  const makeStartOp = () =>
    new WithStartWorkflowOperation(workflowWithNeverReturningUpdate, {
      workflowId,
      taskQueue,
      workflowIdConflictPolicy: 'USE_EXISTING',
    });
  const startUpdateWithStart = async (startOp: WithStartWorkflowOperation<typeof workflowWithNeverReturningUpdate>) => {
    await t.context.env.client.workflow.startUpdateWithStart(neverReturningUpdate, {
      waitForStage: 'ACCEPTED',
      startWorkflowOperation: startOp,
    });
  };

  await worker.runUntil(async () => {
    // The server permits 10 updates per workflow execution.
    for (let i = 0; i < 10; i++) {
      const startOp = makeStartOp();
      await startUpdateWithStart(startOp);
      await startOp.workflowHandle;
    }
    // The 11th call should fail with a gRPC error

    // TODO: set gRPC retries to 1. This generates a RESOURCE_EXHAUSTED error,
    // and by default these are retried 10 times.
    const startOp = makeStartOp();
    for (const promise of [startUpdateWithStart(startOp), startOp.workflowHandle()]) {
      const err = await t.throwsAsync(promise);
      t.true(isGrpcServiceError(err) && err.code === grpcStatus.RESOURCE_EXHAUSTED);
    }
  });
});

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

    const updateHandle = await wfHandle.startUpdate(update, {
      args: ['1'],
      waitForStage: WorkflowUpdateStage.ACCEPTED,
    });
    const updateResult = await updateHandle.result();
    t.deepEqual(updateResult, ['1']);

    const doneUpdateHandle = await wfHandle.startUpdate(doneUpdate, {
      waitForStage: WorkflowUpdateStage.ACCEPTED,
    });
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
    const updateHandleFromStartUpdate = await wfHandle.startUpdate(update, {
      args: ['1'],
      updateId,
      waitForStage: WorkflowUpdateStage.ACCEPTED,
    });

    // Obtain update handle on workflow handle from start update.
    const updateHandle = wfHandle.getUpdateHandle(updateId);
    t.deepEqual(await updateHandle.result(), ['1']);

    // Obtain update handle on manually-created workflow handle with no run id.
    t.truthy(updateHandleFromStartUpdate.workflowRunId);
    const freshWorkflowHandleWithoutRunId = t.context.env.client.workflow.getHandle(wfHandle.workflowId);
    const updateHandle2 = freshWorkflowHandleWithoutRunId.getUpdateHandle(updateId);
    t.deepEqual(await updateHandle2.result(), ['1']);

    // Obtain update handle on manually-created workflow handle with run id.
    const freshWorkflowHandleWithRunId = t.context.env.client.workflow.getHandle(
      wfHandle.workflowId,
      updateHandleFromStartUpdate.workflowRunId
    );
    const updateHandle3 = freshWorkflowHandleWithRunId.getUpdateHandle(updateId);
    t.deepEqual(await updateHandle3.result(), ['1']);

    // Obtain update handle on manually-created workflow handle with incorrect run id.
    const workflowHandleWithIncorrectRunId = t.context.env.client.workflow.getHandle(wfHandle.workflowId, wf.uuid4());
    const updateHandle4 = workflowHandleWithIncorrectRunId.getUpdateHandle(updateId);
    const err = await t.throwsAsync(updateHandle4.result());
    t.true(err instanceof wf.WorkflowNotFoundError);
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
    let updateHandle = await wfHandle.startUpdate(stringToStringUpdate, {
      args: ['arg'],
      waitForStage: WorkflowUpdateStage.ACCEPTED,
    });
    t.is(await updateHandle.result(), 'update-result');
    updateHandle = await wfHandle.startUpdate(stringToStringUpdate, {
      args: ['bad-arg'],
      waitForStage: WorkflowUpdateStage.ACCEPTED,
    });
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
    const updateHandle = await wfHandle.startUpdate(doneUpdate, {
      updateId: 'my-update-id',
      waitForStage: WorkflowUpdateStage.ACCEPTED,
    });
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
    const secondUpdateHandle = await wfHandle.startUpdate(incrementAndGetValueUpdate, {
      args: [2],
      waitForStage: WorkflowUpdateStage.ACCEPTED,
    });
    const secondUpdateResult = await secondUpdateHandle.result();
    t.is(secondUpdateResult, 8);
    await wfHandle.cancel();
    await assertWorkflowFailedError(wfHandle.result(), wf.CancelledFailure);
  });
});

test('startUpdate does not return handle before update has reached requested stage', async (t) => {
  const { startWorkflow } = helpers(t);
  const wfHandle = await startWorkflow(workflowWithUpdates);
  const updatePromise = wfHandle
    .startUpdate(update, {
      args: ['1'],
      waitForStage: WorkflowUpdateStage.ACCEPTED,
    })
    .then(() => 'update');
  const timeoutPromise = new Promise<string>((f) =>
    setTimeout(() => f('timeout'), LONG_POLL_EXPIRATION_INTERVAL_SECONDS * 1500)
  );
  t.is(
    await Promise.race([updatePromise, timeoutPromise]),
    'timeout',
    'The update call should never return, since it should be waiting until Accepted, yet there is no worker.'
  );
});

test('Interruption of update by server long-poll timeout is invisible to client', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdates);
    const arg = 'wait-for-longer-than-server-long-poll-timeout';
    const updateResult = await wfHandle.executeUpdate(update, { args: [arg] });
    t.deepEqual(updateResult, [arg]);
    await wfHandle.executeUpdate(doneUpdate);
    const wfResult = await wfHandle.result();
    t.deepEqual(wfResult, [arg, 'done', '$']);
  });
});

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

test('currentUpdateInfo returns the update id', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithCurrentUpdateInfo);
    const updateIds = await Promise.all([
      wfHandle.executeUpdate(currentInfoUpdate, { updateId: 'update1' }),
      wfHandle.executeUpdate(currentInfoUpdate, { updateId: 'update2' }),
      wfHandle.executeUpdate(currentInfoUpdate, { updateId: 'update3' }),
      wfHandle.executeUpdate(currentInfoUpdate, { updateId: 'update4' }),
      wfHandle.executeUpdate(currentInfoUpdate, { updateId: 'update5' }),
    ]);
    t.deepEqual(updateIds, ['update1', 'update2', 'update3', 'update4', 'update5']);
    const wfResults = await wfHandle.result();
    t.deepEqual(wfResults.sort(), ['update1', 'update2', 'update3', 'update4', 'update5']);
  });
});

test('startUpdate throws WorkflowUpdateRPCTimeoutOrCancelledError with no worker', async (t) => {
  const { startWorkflow } = helpers(t);
  const wfHandle = await startWorkflow(workflowWithUpdates);
  await t.context.env.client.withDeadline(Date.now() + 100, async () => {
    const err = await t.throwsAsync(
      wfHandle.startUpdate(update, { args: ['1'], waitForStage: WorkflowUpdateStage.ACCEPTED })
    );
    t.true(err instanceof WorkflowUpdateRPCTimeoutOrCancelledError);
  });

  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 10);
  await t.context.env.client.withAbortSignal(ctrl.signal, async () => {
    const err = await t.throwsAsync(
      wfHandle.startUpdate(update, { args: ['1'], waitForStage: WorkflowUpdateStage.ACCEPTED })
    );
    t.true(err instanceof WorkflowUpdateRPCTimeoutOrCancelledError);
  });
});

test('update result poll throws WorkflowUpdateRPCTimeoutOrCancelledError', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithUpdates);
    const arg = 'wait-for-longer-than-server-long-poll-timeout';
    await t.context.env.client.withDeadline(Date.now() + LONG_POLL_EXPIRATION_INTERVAL_SECONDS * 1000, async () => {
      const err = await t.throwsAsync(wfHandle.executeUpdate(update, { args: [arg] }));
      t.true(err instanceof WorkflowUpdateRPCTimeoutOrCancelledError);
    });

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), LONG_POLL_EXPIRATION_INTERVAL_SECONDS * 1000);
    await t.context.env.client.withAbortSignal(ctrl.signal, async () => {
      const err = await t.throwsAsync(wfHandle.executeUpdate(update, { args: [arg] }));
      t.true(err instanceof WorkflowUpdateRPCTimeoutOrCancelledError);
    });
  });
});

const updateThatShouldFail = wf.defineUpdate('updateThatShouldFail');

export async function workflowThatWillBeCancelled(): Promise<void> {
  wf.setHandler(updateThatShouldFail, async () => {
    await wf.condition(() => false);
  });
  await wf.condition(() => false);
}

test('update caller gets update failed error on workflow cancellation', async (t) => {
  const { createWorker, startWorkflow, assertWorkflowUpdateFailed } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const w = await startWorkflow(workflowThatWillBeCancelled);
    const u = await w.startUpdate(updateThatShouldFail, {
      waitForStage: WorkflowUpdateStage.ACCEPTED,
    });
    await w.cancel();
    await assertWorkflowUpdateFailed(u.result(), wf.CancelledFailure, 'Workflow cancelled');
  });
});

export { signalUpdateOrderingWorkflow };

// Validate that issue #1474 is fixed in 1.11.0+
test("Pending promises can't unblock between signals and updates", async (t) => {
  const { createWorker, startWorkflow, updateHasBeenAdmitted } = helpers(t);

  const handle = await startWorkflow(signalUpdateOrderingWorkflow);
  const worker1 = await createWorker({ maxCachedWorkflows: 0 });
  await worker1.runUntil(async () => {
    // Wait for the workflow to reach the first condition
    await handle.executeUpdate('fooUpdate');
  });

  const updateId = 'update-id';
  await handle.signal('fooSignal');
  const updateResult = handle.executeUpdate('fooUpdate', { updateId });
  await waitUntil(() => updateHasBeenAdmitted(handle, updateId), 5000);

  const worker2 = await createWorker();
  await worker2.runUntil(async () => {
    t.is(await handle.result(), 3);
    t.is(await updateResult, 3);
  });
});

export { signalsActivitiesTimersPromiseOrdering };

// A broader check covering issue #1474, but also other subtle ordering issues caused by the fact
// that signals used to be processed in a distinct phase from other types of jobs.
test('Signals/Updates/Activities/Timers have coherent promise completion ordering', async (t) => {
  const { createWorker, startWorkflow, taskQueue, updateHasBeenAdmitted } = helpers(t);

  // We need signal+update+timer completion+activity completion to all happen in the same workflow task.
  // To get there, as soon as the activity gets scheduled, we shutdown the workflow worker, then send
  // the signal and update while there is no worker alive. When it eventually comes back up, all events
  // will be queued up for the next WFT.

  const worker1 = await createWorker({ maxCachedWorkflows: 0 });
  const worker1Promise = worker1.run();
  const killWorker1 = async () => {
    try {
      worker1.shutdown();
    } catch {
      // We may attempt to shutdown the worker multiple times. Ignore errors.
    }
    await worker1Promise;
  };

  try {
    const activityWorker = await createWorker({
      taskQueue: `${taskQueue}-activity`,
      activities: { myActivity: killWorker1 },
      workflowBundle: undefined,
      workflowsPath: undefined,
    });
    await activityWorker.runUntil(async () => {
      const handle = await startWorkflow(signalsActivitiesTimersPromiseOrdering);

      // The workflow will schedule the activity, which will shutdown the worker.
      // Then this promise will resolves.
      await worker1Promise;

      await handle.signal('aaSignal');
      const updateId = 'update-id';
      const updatePromise = handle.executeUpdate('aaUpdate', { updateId });

      // Timing is important here. Make sure that everything is ready before creating the new worker.
      await waitUntil(async () => {
        const updateAdmitted = await updateHasBeenAdmitted(handle, updateId);
        if (!updateAdmitted) return false;

        const { events } = await handle.fetchHistory();
        return (
          events != null &&
          events.some((e) => e.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_ACTIVITY_TASK_COMPLETED) &&
          events.some((e) => e.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_TIMER_FIRED) &&
          events.some((e) => e.eventType === temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED)
        );
      }, 5000);

      await (
        await createWorker({})
      ).runUntil(async () => {
        t.deepEqual(await handle.result(), [true, true, true, true]);
      });

      await updatePromise;
    });
  } finally {
    await killWorker1();
  }
});

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

test('Can complete update after workflow returns', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(canCompleteUpdateAfterWorkflowReturns);
    const updateHandler = await handle.executeUpdate(wf.defineUpdate<string>('doneUpdate'));
    await handle.result();

    await t.is(updateHandler, 'completed');
  });
});

test('Can complete update after Workflow fails', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(canCompleteUpdateAfterWorkflowReturns, { args: [true] });
    const updateHandler = await handle.executeUpdate(wf.defineUpdate<string>('doneUpdate'));
    await t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError });
    await t.is(updateHandler, 'completed');
  });
});

/**
 * The {@link canCompleteUpdateAfterWorkflowReturns} workflow above features an update handler that
 * return safter the main workflow functions has returned. It will (assuming an update is sent in
 * the first WFT) generate a raw command sequence (before sending to core) of:
 *
 *   [UpdateAccepted, CompleteWorkflowExecution, UpdateCompleted].
 *
 * Prior to https://github.com/temporalio/sdk-typescript/pull/1488, TS SDK ignored any command
 * produced after a completion command, therefore truncating this command sequence to:
 *
 *   [UpdateAccepted, CompleteWorkflowExecution].
 *
 * Starting with #1488, TS SDK now performs no truncation, and Core reorders the sequence to:
 *
 *   [UpdateAccepted, UpdateCompleted, CompleteWorkflowExecution].
 *
 * This test takes a history generated using pre-#1488 SDK code, and replays it. That history
 * contains the following events:
 *
 *   1 WorkflowExecutionStarted
 *   2 WorkflowTaskScheduled
 *   3 WorkflowTaskStarted
 *   4 WorkflowTaskCompleted
 *   5 WorkflowExecutionUpdateAccepted
 *   6 WorkflowExecutionCompleted
 *
 * Note that the history lacks a `WorkflowExecutionUpdateCompleted` event.
 *
 * If Core's logic (which involves a flag) incorrectly allowed this history to be replayed using
 * Core's post-#1488 implementation, then a non-determinism error would result. Specifically, Core
 * would, at some point during replay, do the following:
 *
 *  - Receive [UpdateAccepted, CompleteWorkflowExecution, UpdateCompleted] from lang;
 *  - Change that to `[UpdateAccepted, UpdateCompleted, CompleteWorkflowExecution]`;
 *  - Create an `UpdateMachine` instance (the `WorkflowTaskMachine` instance already exists).
 *  - Continue to consume history events.
 *
 * Event 5, `WorkflowExecutionUpdateAccepted`, would apply to the `UpdateMachine` associated with
 * the `UpdateAccepted` command, but event 6, `WorkflowExecutionCompleted` would not, since Core is
 * expecting an event that can be applied to the `UpdateMachine` corresponding to `UpdateCompleted`.
 * If we modify Core to incorrectly apply its new logic then we do see that:
 *
 *   [TMPRL1100] Nondeterminism error: Update machine does not handle this event: HistoryEvent(id: 6, WorkflowExecutionCompleted)
 *
 * The test passes because Core in fact (because the history lacks the flag) uses its old logic and
 * changes the command sequence from `[UpdateAccepted, CompleteWorkflowExecution, UpdateCompleted]`
 * to `[UpdateAccepted, CompleteWorkflowExecution]`, i.e. truncating commands emitted after the
 * first completion command like TS SDK used to do, so that events 5 and 6 can be applied to the
 * corresponding state machines.
 */
test('Can complete update after workflow returns - pre-1.11.0 compatibility', async (t) => {
  const { runReplayHistory } = helpers(t);
  const hist = await loadHistory('complete_update_after_workflow_returns_pre1488.json');
  await runReplayHistory({}, hist);
  t.pass();
});

const logUpdate = wf.defineUpdate<[string, string], [string]>('log-update');
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

test('Workflow Worker logs update info when logging within update handler', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const wfHandle = await startWorkflow(workflowWithLogInUpdate);
    const logMsg = 'log msg';
    const [updateId, updateName] = await wfHandle.executeUpdate(logUpdate, { args: [logMsg] });
    t.true(
      recordedLogs[wfHandle.workflowId].some(
        (logEntry) =>
          logEntry.meta?.updateName === updateName &&
          logEntry.meta?.updateId === updateId &&
          logEntry.message === logMsg
      )
    );
  });
});
