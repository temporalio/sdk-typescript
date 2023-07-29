// @@@SNIPSTART typescript-logger-sink-workflow
import * as wf from '@temporalio/workflow';

export async function logSampleWorkflow(): Promise<void> {
  wf.log.info('Workflow execution started');
}
// @@@SNIPEND
