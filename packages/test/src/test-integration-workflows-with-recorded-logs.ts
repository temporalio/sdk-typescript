import { ExecutionContext } from 'ava';
import * as workflow from '@temporalio/workflow';
import { ApplicationFailureCategory, HandlerUnfinishedPolicy } from '@temporalio/common';
import { LogEntry } from '@temporalio/worker';
import { WorkflowFailedError, WorkflowUpdateFailedError } from '@temporalio/client';
import { Context, helpers, makeTestFunction } from './helpers-integration';
import { waitUntil } from './helpers';

const recordedLogs: { [workflowId: string]: LogEntry[] } = {};
const test = makeTestFunction({
  workflowsPath: __filename,
  recordedLogs,
});

export const unfinishedHandlersUpdate = workflow.defineUpdate<void>('unfinished-handlers-update');
export const unfinishedHandlersUpdate_ABANDON = workflow.defineUpdate<void>('unfinished-handlers-update-ABANDON');
export const unfinishedHandlersUpdate_WARN_AND_ABANDON = workflow.defineUpdate<void>(
  'unfinished-handlers-update-WARN_AND_ABANDON'
);
export const unfinishedHandlersSignal = workflow.defineSignal('unfinished-handlers-signal');
export const unfinishedHandlersSignal_ABANDON = workflow.defineSignal('unfinished-handlers-signal-ABANDON');
export const unfinishedHandlersSignal_WARN_AND_ABANDON = workflow.defineSignal(
  'unfinished-handlers-signal-WARN_AND_ABANDON'
);

/**
 * A workflow for testing `workflow.allHandlersFinished()` and control of
 * warnings by HandlerUnfinishedPolicy.
 */
export async function unfinishedHandlersWorkflow(waitAllHandlersFinished: boolean): Promise<boolean> {
  let startedHandler = false;
  let handlerMayReturn = false;
  let handlerFinished = false;

  const doUpdateOrSignal = async (): Promise<void> => {
    startedHandler = true;
    await workflow.condition(() => handlerMayReturn);
    handlerFinished = true;
  };

  workflow.setHandler(unfinishedHandlersUpdate, doUpdateOrSignal);
  workflow.setHandler(unfinishedHandlersUpdate_ABANDON, doUpdateOrSignal, {
    unfinishedPolicy: HandlerUnfinishedPolicy.ABANDON,
  });
  workflow.setHandler(unfinishedHandlersUpdate_WARN_AND_ABANDON, doUpdateOrSignal, {
    unfinishedPolicy: HandlerUnfinishedPolicy.WARN_AND_ABANDON,
  });
  workflow.setHandler(unfinishedHandlersSignal, doUpdateOrSignal);
  workflow.setHandler(unfinishedHandlersSignal_ABANDON, doUpdateOrSignal, {
    unfinishedPolicy: HandlerUnfinishedPolicy.ABANDON,
  });
  workflow.setHandler(unfinishedHandlersSignal_WARN_AND_ABANDON, doUpdateOrSignal, {
    unfinishedPolicy: HandlerUnfinishedPolicy.WARN_AND_ABANDON,
  });
  workflow.setDefaultSignalHandler(doUpdateOrSignal);

  await workflow.condition(() => startedHandler);
  if (waitAllHandlersFinished) {
    handlerMayReturn = true;
    await workflow.condition(workflow.allHandlersFinished);
  }
  return handlerFinished;
}

// These tests confirms that the unfinished-handler warning is issued, and respects the policy, and
// can be avoided by waiting for the `allHandlersFinished` condition.
test('unfinished update handler', async (t) => {
  await new UnfinishedHandlersTest(t, 'update').testWaitAllHandlersFinishedAndUnfinishedHandlersWarning();
});

test('unfinished signal handler', async (t) => {
  await new UnfinishedHandlersTest(t, 'signal').testWaitAllHandlersFinishedAndUnfinishedHandlersWarning();
});

class UnfinishedHandlersTest {
  constructor(
    private readonly t: ExecutionContext<Context>,
    private readonly handlerType: 'update' | 'signal'
  ) {}

  async testWaitAllHandlersFinishedAndUnfinishedHandlersWarning() {
    // The unfinished handler warning is issued by default,
    let [handlerFinished, warning] = await this.getWorkflowResultAndWarning(false);
    this.t.false(handlerFinished);
    this.t.true(warning);

    // and when the workflow sets the unfinished_policy to WARN_AND_ABANDON,
    [handlerFinished, warning] = await this.getWorkflowResultAndWarning(
      false,
      HandlerUnfinishedPolicy.WARN_AND_ABANDON
    );
    this.t.false(handlerFinished);
    this.t.true(warning);

    // and when a default (aka dynamic) handler is used
    if (this.handlerType === 'signal') {
      [handlerFinished, warning] = await this.getWorkflowResultAndWarning(false, undefined, true);
      this.t.false(handlerFinished);
      this.t.true(warning);
    } else {
      // default handlers not supported yet for update
      // https://github.com/temporalio/sdk-typescript/issues/1460
    }

    // but not when the workflow waits for handlers to complete,
    [handlerFinished, warning] = await this.getWorkflowResultAndWarning(true);
    this.t.true(handlerFinished);
    this.t.false(warning);

    // TODO: make default handlers honor HandlerUnfinishedPolicy
    // [handlerFinished, warning] = await this.getWorkflowResultAndWarning(true, undefined, true);
    // this.t.true(handlerFinished);
    // this.t.false(warning);

    // nor when the silence-warnings policy is set on the handler.
    [handlerFinished, warning] = await this.getWorkflowResultAndWarning(false, HandlerUnfinishedPolicy.ABANDON);
    this.t.false(handlerFinished);
    this.t.false(warning);
  }

  /**
   * Run workflow and send signal/update. Return two booleans:
   * - did the handler complete? (i.e. the workflow return value)
   * - was an unfinished handler warning emitted?
   */
  async getWorkflowResultAndWarning(
    waitAllHandlersFinished: boolean,
    unfinishedPolicy?: HandlerUnfinishedPolicy,
    useDefaultHandler?: boolean
  ): Promise<[boolean, boolean]> {
    const { createWorker, startWorkflow } = helpers(this.t);
    const worker = await createWorker();
    return await worker.runUntil(async () => {
      const handle = await startWorkflow(unfinishedHandlersWorkflow, { args: [waitAllHandlersFinished] });
      let messageType: string;
      if (useDefaultHandler) {
        messageType = '__no_registered_handler__';
        this.t.falsy(unfinishedPolicy); // default handlers do not support setting the unfinished policy
      } else {
        messageType = `unfinished-handlers-${this.handlerType}`;
        if (unfinishedPolicy) {
          messageType += '-' + HandlerUnfinishedPolicy[unfinishedPolicy];
        }
      }
      switch (this.handlerType) {
        case 'signal':
          await handle.signal(messageType);
          break;
        case 'update': {
          const executeUpdate = handle.executeUpdate(messageType, { updateId: 'my-update-id' });
          if (!waitAllHandlersFinished) {
            await assertWorkflowUpdateFailedBecauseWorkflowCompleted(this.t, executeUpdate);
          } else {
            await executeUpdate;
          }
          break;
        }
      }
      const handlerFinished = await handle.result();
      const unfinishedHandlerWarningEmitted =
        recordedLogs[handle.workflowId] &&
        recordedLogs[handle.workflowId].findIndex((e) => this.isUnfinishedHandlerWarning(e)) >= 0;
      return [handlerFinished, unfinishedHandlerWarningEmitted];
    });
  }

  isUnfinishedHandlerWarning(logEntry: LogEntry): boolean {
    return (
      logEntry.level === 'WARN' &&
      new RegExp(`^\\[TMPRL1102\\] Workflow finished while an? ${this.handlerType} handler was still running\\.`).test(
        logEntry.message
      )
    );
  }
}

export const unfinishedHandlersWorkflowTerminationTypeUpdate = workflow.defineUpdate<string>(
  'unfinishedHandlersWorkflowTerminationTypeUpdate'
);
export const unfinishedHandlersWorkflowTerminationTypeSignal = workflow.defineSignal(
  'unfinishedHandlersWorkflowTerminationTypeSignal'
);

export async function runUnfinishedHandlersWorkflowTerminationTypeWorkflow(
  workflowTerminationType:
    | 'cancellation'
    | 'cancellation-with-shielded-handler'
    | 'continue-as-new'
    | 'failure'
    | 'return',
  waitAllHandlersFinished?: 'wait-all-handlers-finished'
): Promise<void> {
  let handlerMayReturn = false;

  const waitHandlerMayReturn = async () => {
    if (workflowTerminationType === 'cancellation-with-shielded-handler') {
      await workflow.CancellationScope.nonCancellable(async () => {
        await workflow.condition(() => handlerMayReturn);
      });
    } else {
      await workflow.condition(() => handlerMayReturn);
    }
  };

  workflow.setHandler(unfinishedHandlersWorkflowTerminationTypeUpdate, async () => {
    await waitHandlerMayReturn();
    return 'update-result';
  });

  workflow.setHandler(unfinishedHandlersWorkflowTerminationTypeSignal, async () => {
    await waitHandlerMayReturn();
  });

  switch (workflowTerminationType) {
    case 'cancellation':
    case 'cancellation-with-shielded-handler':
      await workflow.condition(() => false);
      throw new Error('unreachable');
    case 'continue-as-new':
      if (waitAllHandlersFinished) {
        handlerMayReturn = true;
        await workflow.condition(workflow.allHandlersFinished);
      }
      // If we do not pass waitAllHandlersFinished here then the test occasionally fails. Recall
      // that this test causes the worker to send a WFT response containing commands
      // [completeUpdate, CAN]. Usually, that results in the update completing, the caller getting
      // the update result, and the workflow CANing. However occasionally (~1/30) there is a server
      // level=ERROR msg="service failures" operation=UpdateWorkflowExecution wf-namespace=default error="unable to locate current workflow execution"
      // the update caller does not get a response, and the update is included again in the first
      // WFT sent to the post-CAN workflow run. (This causes the current test to fail unless the
      // post-CAN run waits for handlers to finish).
      await workflow.continueAsNew('return', waitAllHandlersFinished);
      throw new Error('unreachable');
    case 'failure':
      throw new workflow.ApplicationFailure('Deliberately failing workflow with an unfinished handler');
    case 'return':
      if (waitAllHandlersFinished) {
        handlerMayReturn = true;
        await workflow.condition(workflow.allHandlersFinished);
      }
      break;
  }
}

// These tests confirm that the warning is issued / not issued as appropriate for workflow
// termination via cancellation, continue-as-new, failure, and return, and that there is no warning
// when waiting on allHandlersFinished before return or continue-as-new.

// We issue the warning if the workflow exited due to workflow return and there were unfinished
// handlers. Reason: the workflow author could/should have avoided this.

test('unfinished update handler with workflow return', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(t, 'update', 'return').testWarningIsIssued(true);
});

test('unfinished update handler with workflow return waiting for all handlers to finish', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(
    t,
    'update',
    'return',
    'wait-all-handlers-finished'
  ).testWarningIsIssued(false);
});

test('unfinished signal handler with workflow return', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(t, 'signal', 'return').testWarningIsIssued(true);
});

test('unfinished signal handler with workflow return waiting for all handlers to finish', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(
    t,
    'signal',
    'return',
    'wait-all-handlers-finished'
  ).testWarningIsIssued(false);
});

// We issue the warning if the workflow exited due to workflow cancellation and there were
// unfinished handlers. Reason: workflow cancellation causes handler cancellation, so a workflow
// author is able to write a workflow that handles cancellation without leaving unfinished handlers.

test('workflow cancellation does not cause unfinished update handler warnings because handler is cancelled', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(t, 'update', 'cancellation').testWarningIsIssued(false);
});

test('workflow cancellation does not cause unfinished signal handler warnings because handler is cancelled', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(t, 'signal', 'cancellation').testWarningIsIssued(false);
});

test('workflow cancellation causes unfinished update handler warnings when handler is not cancelled', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(
    t,
    'update',
    'cancellation-with-shielded-handler'
  ).testWarningIsIssued(true);
});

test('workflow cancellation causes unfinished signal handler warnings when handler is not cancelled', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(
    t,
    'signal',
    'cancellation-with-shielded-handler'
  ).testWarningIsIssued(true);
});

// We issue the warning if the workflow exited due to Continue-as-New and there were unfinished
// handlers. Reason: as with workflow return, the workflow author could/should have avoided this,
// and in this case the workflow is probably acting as some sort of task processor that must not
// drop work.

test('unfinished update handler with continue-as-new', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(t, 'update', 'continue-as-new').testWarningIsIssued(true);
});

test('unfinished update handler with continue-as-new waiting for all handlers to finish', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(
    t,
    'update',
    'continue-as-new',
    'wait-all-handlers-finished'
  ).testWarningIsIssued(false);
});

test('unfinished signal handler with continue-as-new', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(t, 'signal', 'continue-as-new').testWarningIsIssued(true);
});

test('unfinished signal handler with continue-as-new waiting for all handlers to finish', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(
    t,
    'signal',
    'continue-as-new',
    'wait-all-handlers-finished'
  ).testWarningIsIssued(false);
});

// We do not issue the warning if the workflow finished due to failure and there were unfinished
// handlers. Reason: the workflow author cannot guarantee to avoid workflow failure: e.g. it might
// happen by an error thrown from executeActivity.

test('unfinished update handler with workflow failure', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(t, 'update', 'failure').testWarningIsIssued(false);
});

test('unfinished signal handler with workflow failure', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(t, 'signal', 'failure').testWarningIsIssued(false);
});

class UnfinishedHandlersWorkflowTerminationTypeTest {
  constructor(
    private readonly t: ExecutionContext<Context>,
    private readonly handlerType: 'update' | 'signal',
    private readonly workflowTerminationType:
      | 'cancellation'
      | 'cancellation-with-shielded-handler'
      | 'continue-as-new'
      | 'failure'
      | 'return',
    private readonly waitAllHandlersFinished?: 'wait-all-handlers-finished'
  ) {}

  async testWarningIsIssued(expectWarning: boolean) {
    this.t.is(await this.runWorkflowAndGetWarning(), expectWarning);
  }

  async runWorkflowAndGetWarning(): Promise<boolean> {
    const { createWorker, startWorkflow, updateHasBeenAdmitted: workflowUpdateExists } = helpers(this.t);
    const updateId = 'update-id';

    // We require a startWorkflow, an update/signal, and maybe a cancellation request, to be
    // delivered in the same WFT, so we ensure they've all been accepted by the server before
    // starting the worker.
    const w = await startWorkflow(runUnfinishedHandlersWorkflowTerminationTypeWorkflow, {
      args: [this.workflowTerminationType, this.waitAllHandlersFinished],
    });
    let executeUpdate: Promise<string>;
    switch (this.handlerType) {
      case 'update':
        executeUpdate = w.executeUpdate(unfinishedHandlersWorkflowTerminationTypeUpdate, { updateId });
        await waitUntil(() => workflowUpdateExists(w, updateId), 5000);
        break;
      case 'signal':
        await w.signal(unfinishedHandlersWorkflowTerminationTypeSignal);
        break;
    }
    if (
      this.workflowTerminationType === 'cancellation' ||
      this.workflowTerminationType === 'cancellation-with-shielded-handler'
    ) {
      await w.cancel();
    }

    const worker = await createWorker();

    return await worker.runUntil(async () => {
      if (this.handlerType === 'update') {
        if (this.waitAllHandlersFinished) {
          // The workflow author waited for allHandlersFinished and so the update caller gets a
          // successful result.
          this.t.is(await executeUpdate, 'update-result');
        } else if (this.workflowTerminationType === 'cancellation') {
          // Workflow cancellation caused a CancellationFailure exception to be thrown in the
          // handler. The update caller gets an error saying the update failed due to workflow
          // cancellation.
          await this.assertWorkflowUpdateFailedError(executeUpdate);
        } else {
          // (Including 'cancellation-with-shielded-handler'). The workflow finished while the
          // handler was in-progress. The update caller gets an WorkflowUpdateFailedError error,
          // with an ApplicationFailure cause whose type is AcceptedUpdateCompletedWorkflow
          await assertWorkflowUpdateFailedBecauseWorkflowCompleted(this.t, executeUpdate);
        }
      }
      switch (this.workflowTerminationType) {
        case 'cancellation':
        case 'cancellation-with-shielded-handler':
        case 'failure':
          await this.assertWorkflowFailedError(w.result(), this.workflowTerminationType);
          break;
        case 'return':
        case 'continue-as-new':
          await w.result();
      }
      return (
        w.workflowId in recordedLogs &&
        recordedLogs[w.workflowId].findIndex((e) => this.isUnfinishedHandlerWarning(e)) >= 0
      );
    });
  }

  async assertWorkflowUpdateFailedError(p: Promise<any>) {
    const err: WorkflowUpdateFailedError = (await this.t.throwsAsync(p, {
      instanceOf: WorkflowUpdateFailedError,
    })) as WorkflowUpdateFailedError;
    this.t.is(err.message, 'Workflow Update failed');
  }

  async assertWorkflowFailedError(
    p: Promise<any>,
    workflowTerminationType: 'cancellation' | 'cancellation-with-shielded-handler' | 'failure'
  ) {
    const err = (await this.t.throwsAsync(p, {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;
    const howFailed = {
      cancellation: 'cancelled',
      'cancellation-with-shielded-handler': 'cancelled',
      failure: 'failed',
    }[workflowTerminationType];
    this.t.is(err.message, 'Workflow execution ' + howFailed);
  }

  isUnfinishedHandlerWarning(logEntry: LogEntry): boolean {
    return (
      logEntry.level === 'WARN' &&
      new RegExp(`^\\[TMPRL1102\\] Workflow finished while an? ${this.handlerType} handler was still running\\.`).test(
        logEntry.message
      )
    );
  }
}

async function assertWorkflowUpdateFailedBecauseWorkflowCompleted(t: ExecutionContext<Context>, p: Promise<any>) {
  const err: WorkflowUpdateFailedError = (await t.throwsAsync(p, {
    instanceOf: WorkflowUpdateFailedError,
  })) as WorkflowUpdateFailedError;

  const cause = err.cause;
  t.true(cause instanceof workflow.ApplicationFailure);
  t.true((cause as workflow.ApplicationFailure).type === 'AcceptedUpdateCompletedWorkflow');
  t.regex((cause as workflow.ApplicationFailure).message, /Workflow completed before the Update completed/);
}

export async function raiseErrorWorkflow(useBenign: boolean): Promise<void> {
  await workflow
    .proxyActivities({ startToCloseTimeout: '10s', retry: { maximumAttempts: 1 } })
    .throwApplicationFailureActivity(useBenign);
}

test('Application failure category controls log level', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker({
    activities: {
      async throwApplicationFailureActivity(useBenign: boolean) {
        throw workflow.ApplicationFailure.create({
          category: useBenign ? ApplicationFailureCategory.BENIGN : undefined,
        });
      },
    },
  });

  await worker.runUntil(async () => {
    // Run with BENIGN
    let handle = await startWorkflow(raiseErrorWorkflow, { args: [true] });
    try {
      await handle.result();
    } catch (_) {
      const logs = recordedLogs[handle.workflowId];
      const activityFailureLog = logs.find((log) => log.message.includes('Activity failed'));
      t.true(activityFailureLog !== undefined && activityFailureLog.level === 'DEBUG');
    }

    // Run without BENIGN
    handle = await startWorkflow(raiseErrorWorkflow, { args: [false] });
    try {
      await handle.result();
    } catch (_) {
      const logs = recordedLogs[handle.workflowId];
      const activityFailureLog = logs.find((log) => log.message.includes('Activity failed'));
      t.true(activityFailureLog !== undefined && activityFailureLog.level === 'WARN');
    }
  });
});
