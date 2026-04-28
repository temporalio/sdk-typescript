import { activityInfo, Context } from '@temporalio/activity';
import { ApplicationFailure, ApplicationFailureCategory, CancelledFailure } from '@temporalio/common';

export { queryOwnWf, signalSchedulingWorkflow } from './helpers';

export async function echo(message?: string): Promise<string> {
  return message ?? 'echo';
}

export async function fakeProgress(sleepIntervalMs = 1000, numIters = 100): Promise<void> {
  await signalSchedulingWorkflow('activityStarted');
  try {
    for (let progress = 1; progress <= numIters; ++progress) {
      await Context.current().sleep(sleepIntervalMs);
      Context.current().heartbeat(progress);
    }
  } catch (err) {
    if (!(err instanceof CancelledFailure)) {
      throw err;
    }
    throw err;
  }
}

async function signalSchedulingWorkflow(signalName: string): Promise<void> {
  const { info, client } = Context.current();
  const { workflowExecution } = info;
  const handle = client.workflow.getHandle(workflowExecution.workflowId, workflowExecution.runId);
  await handle.signal(signalName);
}

export async function throwMaybeBenign(): Promise<void> {
  if (activityInfo().attempt === 1) {
    throw ApplicationFailure.create({ message: 'not benign' });
  }
  if (activityInfo().attempt === 2) {
    throw ApplicationFailure.create({ message: 'benign', category: ApplicationFailureCategory.BENIGN });
  }
}
