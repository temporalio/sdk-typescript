import * as wf from '@temporalio/workflow';
import type { CustomLoggerSinks } from './log-sink-tester';
import { unblockSignal } from './definitions';

const { customLogger } = wf.proxySinks<CustomLoggerSinks>();

// Demo for https://github.com/temporalio/sdk-core/issues/589
export async function coreIssue589(): Promise<void> {
  wf.setHandler(wf.defineQuery('q'), () => {
    return 'not important';
  });

  let unblocked = false;
  wf.setHandler(unblockSignal, () => {
    unblocked = true;
  });
  await wf.condition(() => unblocked, 10000);

  customLogger.info(
    `Checkpoint, replaying: ${wf.workflowInfo().unsafe.isReplaying}, hl: ${wf.workflowInfo().historyLength}`
  );
}
