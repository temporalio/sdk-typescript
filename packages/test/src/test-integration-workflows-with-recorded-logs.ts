import { ExecutionContext } from 'ava';
import * as workflow from '@temporalio/workflow';
import { HandlerUnfinishedPolicy, WorkflowNotFoundError } from '@temporalio/common';
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
    await workflow.condition(() => workflow.allHandlersFinished());
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
            const err: workflow.WorkflowNotFoundError = (await this.t.throwsAsync(executeUpdate, {
              instanceOf: workflow.WorkflowNotFoundError,
            })) as workflow.WorkflowNotFoundError;
            this.t.is(err.message, 'workflow execution already completed');
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

export const unfinishedHandlersWorkflowTerminationTypeUpdate = workflow.defineUpdate<void>(
  'unfinishedHandlersWorkflowTerminationTypeUpdate'
);
export const unfinishedHandlersWorkflowTerminationTypeSignal = workflow.defineSignal(
  'unfinishedHandlersWorkflowTerminationTypeSignal'
);

export async function runUnfinishedHandlersWorkflowTerminationTypeWorkflow(
  workflowTerminationType: 'cancellation' | 'continue-as-new' | 'failure' | 'return'
): Promise<void> {
  workflow.setHandler(unfinishedHandlersWorkflowTerminationTypeUpdate, async () => {
    await workflow.condition(() => false);
    throw new Error('unreachable');
  });

  workflow.setHandler(unfinishedHandlersWorkflowTerminationTypeSignal, async () => {
    await workflow.condition(() => false);
    throw new Error('unreachable');
  });

  switch (workflowTerminationType) {
    case 'cancellation':
      await workflow.condition(() => false);
    case 'continue-as-new':
      await workflow.continueAsNew('return');
    case 'failure':
      throw new workflow.ApplicationFailure('Deliberately failing workflow with an unfinished handler');
    case 'return':
      break;
  }
}

// These tests confirm that the warning is issued / not issued as appropriate for workflow
// termination via cancellation, continue-as-new, failure, and return.
test('unfinished update handler with workflow return', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(t, 'update', 'return').testWarningIsIssued(true);
});

test('unfinished signal handler with workflow return', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(t, 'signal', 'return').testWarningIsIssued(true);
});

test('unfinished update handler with workflow cancellation', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(t, 'update', 'cancellation').testWarningIsIssued(false);
});

test('unfinished signal handler with workflow cancellation', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(t, 'signal', 'cancellation').testWarningIsIssued(false);
});

test('unfinished update handler with continue-as-new', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(t, 'update', 'continue-as-new').testWarningIsIssued(true);
});

test('unfinished signal handler with continue-as-new', async (t) => {
  await new UnfinishedHandlersWorkflowTerminationTypeTest(t, 'signal', 'continue-as-new').testWarningIsIssued(true);
});

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
    private readonly workflowTerminationType: 'cancellation' | 'continue-as-new' | 'failure' | 'return'
  ) {}

  async testWarningIsIssued(expectWarning: boolean) {
    this.t.is(await this.runWorkflowAndGetWarning(), expectWarning);
  }

  async runWorkflowAndGetWarning(): Promise<boolean> {
    const { createWorker, startWorkflow, updateHasBeenAdmitted: workflowUpdateExists } = helpers(this.t);

    // We require a startWorkflow, an update/signal, and maybe a cancellation request, to be
    // delivered in the same WFT. To do this we start the worker after they've all been accepted by
    // the server.
    const updateId = 'update-id';

    const w = await startWorkflow(runUnfinishedHandlersWorkflowTerminationTypeWorkflow, {
      args: [this.workflowTerminationType],
    });
    if (this.workflowTerminationType === 'cancellation') {
      await w.cancel();
    }
    let executeUpdate: Promise<void>;

    switch (this.handlerType) {
      case 'update':
        executeUpdate = w.executeUpdate(unfinishedHandlersWorkflowTerminationTypeUpdate, { updateId });
        await waitUntil(() => workflowUpdateExists(w, updateId), 500);
        break;
      case 'signal':
        await w.signal(unfinishedHandlersWorkflowTerminationTypeSignal);
        break;
    }

    const worker = await createWorker();

    return await worker.runUntil(async () => {
      if (this.handlerType === 'update') {
        if (this.workflowTerminationType === 'cancellation') {
          await this.assertWorkflowUpdateFailedError(executeUpdate);
        } else {
          await this.assertWorkflowNotFoundError(executeUpdate);
        }
      }

      if (this.workflowTerminationType === 'cancellation' || this.workflowTerminationType === 'failure') {
        await this.assertWorkflowFailedError(
          w.result(),
          this.workflowTerminationType === 'cancellation' ? 'cancelled' : 'failed'
        );
      } else {
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

  async assertWorkflowFailedError(p: Promise<any>, howFailed: 'cancelled' | 'failed') {
    const err = (await this.t.throwsAsync(p, {
      instanceOf: WorkflowFailedError,
    })) as WorkflowFailedError;
    this.t.is(err.message, 'Workflow execution ' + howFailed);
  }

  async assertWorkflowNotFoundError(p: Promise<any>) {
    const err: WorkflowNotFoundError = (await this.t.throwsAsync(p, {
      instanceOf: WorkflowNotFoundError,
    })) as WorkflowNotFoundError;
    this.t.is(err.message, 'workflow execution already completed');
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
