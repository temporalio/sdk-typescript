import * as wf from '@temporalio/workflow';
import { withLabel, type ContextTrace } from '../payload-converters/serialization-context-converter';

/**
 * Workflow fixtures for serialization-context tests.
 *
 * Payload-path fixtures cover serialization across:
 * - workflow start and result
 * - query, update, and signal payloads
 * - child workflows
 * - remote activities
 * - local activities
 * - heartbeat details
 * - continue-as-new
 * - workflow memo
 * - workflow timer
 * - one small smoke workflow that combines several boundaries
 *
 * Failure-path fixtures cover serialization across:
 * - workflow completion failure
 * - activity failure observed from a workflow
 * - external workflow signal failure
 * - external workflow cancel failure
 */

export type Trace = ContextTrace<string>;

export const { echoTrace, throwAnError, heartbeatTrace } = wf.proxyActivities<{
  echoTrace(input: Trace, label: string): Promise<Trace>;
  throwAnError(useApplicationFailure: boolean, message: string): Promise<void>;
  heartbeatTrace(input: Trace, label: string): Promise<Trace>;
}>({
  startToCloseTimeout: '10s',
  heartbeatTimeout: '1s',
  retry: { maximumAttempts: 2 },
});

const localActivities = wf.proxyLocalActivities<{
  echoTrace(input: Trace, label: string): Promise<Trace>;
  throwAnError(useApplicationFailure: boolean, message: string): Promise<void>;
}>({
  startToCloseTimeout: '10s',
});

export const unblockSignal = wf.defineSignal<[Trace]>('unblock');
export const echoQuery = wf.defineQuery<Trace, [Trace]>('echoQuery');
export const echoUpdate = wf.defineUpdate<Trace, [Trace]>('echoUpdate');

export async function currentWorkflowContext(ctxTrace: Trace): Promise<Trace> {
  return workflowOutput(ctxTrace);
}

export async function messagePassingContexts(): Promise<Trace> {
  let receivedSignal: Trace | undefined;

  wf.setHandler(echoQuery, (trace) => queryOutput(trace));
  wf.setHandler(echoUpdate, (trace) => updateOutput(trace));
  wf.setHandler(unblockSignal, (trace) => {
    receivedSignal = signalReceived(trace);
  });

  await wf.condition(() => receivedSignal !== undefined);
  return receivedSignal as Trace;
}

export async function wfContextWithRemoteActivity(inputTrace: Trace): Promise<Trace> {
  const fromActivity = await echoTrace(activityInput(inputTrace), 'activity-output');
  return workflowOutput(fromActivity);
}

export async function wfContextWithHeartbeatDetails(inputTrace: Trace): Promise<Trace> {
  const fromHeartbeat = await heartbeatTrace(activityInput(inputTrace), 'activity-heartbeat-details');
  return workflowOutput(fromHeartbeat);
}

export async function wfContextWithLocalActivity(inputTrace: Trace): Promise<Trace> {
  const fromLocalActivity = await localActivities.echoTrace(localActivityInput(inputTrace), 'local-activity-output');
  return workflowOutput(fromLocalActivity);
}

export async function wfContextWithContinueAsNew(inputTrace: Trace, shouldContinueAsNew: boolean): Promise<Trace> {
  if (shouldContinueAsNew) {
    return await wf.continueAsNew<typeof wfContextWithContinueAsNew>(continueAsNewInput(inputTrace), false);
  }

  return workflowOutput(inputTrace);
}

export async function childWorkflowContext(inputTrace: Trace): Promise<Trace> {
  return childWorkflowOutput(inputTrace);
}

export async function wfContextWithChildWorkflow(inputTrace: Trace, childId: string): Promise<Trace> {
  const fromChild = await wf.executeChild(childWorkflowContext, {
    args: [childWorkflowInput(inputTrace)],
    workflowId: childId,
  });
  return parentWorkflowOutput(fromChild);
}

export async function wfFailureContext(): Promise<void> {
  throw wf.ApplicationFailure.nonRetryable('wf-failure');
}

export async function wfActivityFailureContext(): Promise<string> {
  try {
    await throwAnError(true, 'activity-failure');
    return 'unexpected success';
  } catch (err) {
    return (err as Error).message;
  }
}

export async function wfExternalSignalFailureContext(missingWorkflowId: string): Promise<string> {
  try {
    const handle = wf.getExternalWorkflowHandle(missingWorkflowId);
    await handle.signal(unblockSignal, { label: 'signal', trace: [] });
    return 'unexpected success';
  } catch (err) {
    return (err as Error).message;
  }
}

export async function wfExternalCancelFailureContext(missingWorkflowId: string): Promise<string> {
  try {
    const handle = wf.getExternalWorkflowHandle(missingWorkflowId);
    await handle.cancel();
    return 'unexpected success';
  } catch (err) {
    return (err as Error).message;
  }
}

export async function wfContextWithUpsertMemo(inputTrace: Trace): Promise<Trace> {
  wf.upsertMemo({
    probe: withLabel(inputTrace, 'memo-upsert'),
  });
  return workflowOutput(inputTrace);
}

export async function wfContextWithTimerSummary(inputTrace: Trace): Promise<Trace> {
  await wf.sleep(1, { summary: 'timer-summary' });
  return workflowOutput(inputTrace);
}

// Run a bunch of boundaries in a single workflow
export async function wfContextSmoke(trace: Trace, shouldContinueAsNew: boolean, childId: string): Promise<Trace> {
  trace = await echoTrace(activityInput(trace), 'activity-output');
  trace = await localActivities.echoTrace(localActivityInput(trace), 'local-activity-output');
  trace = await wf.executeChild(childWorkflowContext, {
    args: [childWorkflowInput(trace)],
    workflowId: childId,
  });

  if (shouldContinueAsNew) {
    return await wf.continueAsNew(continueAsNewInput(trace), false, childId + '-2');
  }
  return workflowOutput(trace);
}

export async function signalReceivingChildWorkflow(): Promise<Trace> {
  let receivedSignal: Trace | undefined;

  wf.setHandler(unblockSignal, (trace) => {
    receivedSignal = signalReceived(trace);
  });

  await wf.condition(() => receivedSignal !== undefined);
  return receivedSignal as Trace;
}

export async function wfExternalSignalSuccessContext(inputTrace: Trace, childId: string): Promise<Trace> {
  const child = await wf.startChild(signalReceivingChildWorkflow, {
    workflowId: childId,
  });

  const external = wf.getExternalWorkflowHandle(child.workflowId, child.firstExecutionRunId);
  await external.signal(unblockSignal, withLabel(inputTrace, 'signal-input'));

  const childTrace = await child.result();
  return workflowOutput(childTrace);
}

export async function failingChildWorkflow(): Promise<void> {
  throw wf.ApplicationFailure.nonRetryable('child-wf-failure');
}

export async function wfChildWorkflowFailureContext(childId: string): Promise<string> {
  try {
    await wf.executeChild(failingChildWorkflow, {
      workflowId: childId,
    });
    return 'unexpected success';
  } catch (err) {
    return (err as Error).message;
  }
}

export async function wfLocalActivityFailureContext(): Promise<string> {
  try {
    await localActivities.throwAnError(true, 'local-activity-failure');
    return 'unexpected success';
  } catch (err) {
    return (err as Error).message;
  }
}

// TODO: add cases for describe (static metadata - summary/details) and list (memo)

// Trace labelling helpers
export const workflowOutput = (trace: Trace): Trace => withLabel(trace, 'wf-output');
export const childWorkflowInput = (trace: Trace): Trace => withLabel(trace, 'child-wf-input');
export const childWorkflowOutput = (trace: Trace): Trace => withLabel(trace, 'child-wf-output');
export const parentWorkflowOutput = (trace: Trace): Trace => withLabel(trace, 'parent-wf-output');
export const continueAsNewInput = (trace: Trace): Trace => withLabel(trace, 'continue-as-new');

export const queryOutput = (trace: Trace): Trace => withLabel(trace, 'query-output');
export const updateOutput = (trace: Trace): Trace => withLabel(trace, 'update-output');
export const signalReceived = (trace: Trace): Trace => withLabel(trace, 'signal-received');

export const activityInput = (trace: Trace): Trace => withLabel(trace, 'activity-input');
export const activityHeartbeatInput = (trace: Trace): Trace => withLabel(trace, 'activity-heartbeat-input');
export const localActivityInput = (trace: Trace): Trace => withLabel(trace, 'local-activity-input');
