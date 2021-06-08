// @@@SNIPSTART nodejs-external-dependencies-logger-workflow
import { Context } from '@temporalio/workflow';
import { LoggerDependencies } from '../interfaces/dependencies';

const { logger } = Context.dependencies<LoggerDependencies>();
// logger cannot be used at the top level as exernal dependencies are not injected yet.
// Wait for Workflow to start (main called) before calling injected dependencies.

export async function main(): Promise<void> {
  logger.info('logging before getting stuck');
}
// @@@SNIPEND
