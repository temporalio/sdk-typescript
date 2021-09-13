// @@@SNIPSTART nodejs-external-dependencies-logger-workflow
import * as wf from '@temporalio/workflow';
import { Empty } from '../interfaces';
import { LoggerDependencies } from '../interfaces/dependencies';

const { logger } = wf.dependencies<LoggerDependencies>();
// logger cannot be used at the top level as exernal dependencies are not injected yet.
// Wait for Workflow to start (execute called) before calling injected dependencies.

export const logSampleWorkflow: Empty = () => ({
  async execute(): Promise<void> {
    logger.info('Workflow execution started');
  },
});
// @@@SNIPEND
