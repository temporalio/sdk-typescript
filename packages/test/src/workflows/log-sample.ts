// @@@SNIPSTART typescript-logger-sink-workflow
import * as wf from '@temporalio/workflow';
import { LoggerSinks } from './definitions';

const { logger } = wf.proxySinks<LoggerSinks>();

export async function logSampleWorkflow(): Promise<void> {
  logger.info('Workflow execution started');
}
// @@@SNIPEND
