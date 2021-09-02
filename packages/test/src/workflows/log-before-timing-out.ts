import { Context } from '@temporalio/workflow';
import { LoggerDependencies } from '../interfaces/dependencies';
import { Empty } from '../interfaces';

const { logger } = Context.dependencies<LoggerDependencies>();

export const logAndTimeout: Empty = () => ({
  async execute() {
    logger.info('logging before getting stuck');
    for (;;) {
      /* Workflow should never complete */
    }
  },
});
