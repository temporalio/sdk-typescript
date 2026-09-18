import * as workflow from '@temporalio/workflow';
import { ApplicationFailureCategory, HandlerUnfinishedPolicy } from '@temporalio/common';

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

export async function raiseErrorWorkflow(useBenign: boolean): Promise<void> {
  await workflow
    .proxyActivities({ startToCloseTimeout: '10s', retry: { maximumAttempts: 1 } })
    .throwApplicationFailureActivity(useBenign);
}
