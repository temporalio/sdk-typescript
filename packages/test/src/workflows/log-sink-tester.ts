/**
 * Workflow used in test-sinks.ts to verify sink replay behavior
 *
 * Also tests workflow.taskInfo()
 * @module
 */

import * as wf from '@temporalio/workflow';
import { LoggerSinks } from './definitions';

const { logger } = wf.proxySinks<LoggerSinks>();

export async function logSinkTester(): Promise<void> {
  logger.info(
    `Workflow execution started, replaying: ${wf.workflowInfo().unsafe.isReplaying}, hl: ${
      wf.workflowInfo().historyLength
    }`
  );
  // We rely on this test to run with workflow cache disabled. This sleep()
  // therefore ends the current WFT, evicting the workflow from cache, and thus
  // causing replay of the first sink call.
  await wf.sleep(1);
  logger.info(
    `Workflow execution completed, replaying: ${wf.workflowInfo().unsafe.isReplaying}, hl: ${
      wf.workflowInfo().historyLength
    }`
  );
}
