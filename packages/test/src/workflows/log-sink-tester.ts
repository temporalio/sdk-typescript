/**
 * Workflow used in test-sinks.ts to verify sink replay behavior
 *
 * Also tests workflow.taskInfo()
 * @module
 */

import * as wf from '@temporalio/workflow';
import { LoggerSinks } from './definitions';
import { successString } from './success-string';

const { logger } = wf.proxySinks<LoggerSinks>();

export async function logSinkTester(): Promise<void> {
  logger.info(
    `Workflow execution started, replaying: ${wf.workflowInfo().unsafe.isReplaying}, hl: ${
      wf.workflowInfo().historyLength
    }`
  );
  // We rely on the test to run with max cached workflows of 1.
  // Executing this child will flush the current workflow from the cache
  // causing replay or the first sink call.
  await wf.executeChild(successString);
  logger.info(
    `Workflow execution completed, replaying: ${wf.workflowInfo().unsafe.isReplaying}, hl: ${
      wf.workflowInfo().historyLength
    }`
  );
}
