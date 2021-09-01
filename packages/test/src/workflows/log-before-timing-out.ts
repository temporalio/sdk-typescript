import { Context } from '@temporalio/workflow';
import { LoggerDependencies } from '../interfaces/dependencies';

const { logger } = Context.dependencies<LoggerDependencies>();

export async function execute(): Promise<void> {
  logger.info('logging before getting stuck');
  for (;;) {
    /* Workflow should never complete */
  }
}
