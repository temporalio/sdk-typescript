import * as workflow from '@temporalio/workflow';

export async function log5Times(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    workflow.log.info(`workflow log ${i}`);
    await workflow.sleep(1);
  }
}
