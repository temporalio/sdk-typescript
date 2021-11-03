import { dependencies } from '@temporalio/workflow';
import { LoggerDependencies } from './definitions';

const { logger } = dependencies<LoggerDependencies>();

export async function logAndTimeout(): Promise<void> {
  logger.info('logging before getting stuck');
  for (;;) {
    /* Workflow should never complete */
  }
}
