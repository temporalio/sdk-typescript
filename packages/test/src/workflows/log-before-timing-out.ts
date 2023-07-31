import { log } from '@temporalio/workflow';

export async function logAndTimeout(): Promise<void> {
  log.info('logging before getting stuck');
  for (;;) {
    /* Workflow should never complete */
  }
}
