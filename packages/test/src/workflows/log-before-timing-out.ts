import { LoggerSinks, proxySinks } from '@temporalio/workflow';

const { defaultWorkerLogger } = proxySinks<LoggerSinks>();

export async function logAndTimeout(): Promise<void> {
  defaultWorkerLogger.info('logging before getting stuck');
  for (;;) {
    /* Workflow should never complete */
  }
}
