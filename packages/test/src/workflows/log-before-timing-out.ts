import { proxySinks } from '@temporalio/workflow';
import { LoggerSinks } from './definitions';

const { logger } = proxySinks<LoggerSinks>();

export async function logAndTimeout(): Promise<void> {
  logger.info('logging before getting stuck');
  for (;;) {
    /* Workflow should never complete */
  }
}
