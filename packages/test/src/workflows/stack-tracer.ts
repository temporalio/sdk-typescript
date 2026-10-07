/**
 * Workflow used in integration-tests: `Stack trace query returns stack that makes sense`
 * @module
 */
import * as wf from '@temporalio/workflow';
import type * as activities from '../activities';
import { unblockOrCancel } from './unblock-or-cancel';

const { queryOwnWf } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

export async function stackTracer(): Promise<[string, string]> {
  const { executeChild, sleep } = wf;
  const trigger = new wf.Trigger<string>();
  const [first] = await Promise.all([
    trigger,
    Promise.race([
      queryOwnWf(wf.stackTraceQuery).then((stack) => trigger.resolve(stack)),
      executeChild(unblockOrCancel),
      sleep(100_000),
    ]),
  ]);
  const second = await queryOwnWf(wf.stackTraceQuery);
  return [first, second];
}

export async function enhancedStackTracer(): Promise<wf.EnhancedStackTrace> {
  const { executeChild, sleep } = wf;
  const trigger = new wf.Trigger<wf.EnhancedStackTrace>();
  const [enhStack] = await Promise.all([
    trigger,
    Promise.race([
      queryOwnWf(wf.enhancedStackTraceQuery).then((stack) => trigger.resolve(stack)),
      executeChild(unblockOrCancel),
      sleep(100_000),
    ]),
  ]);
  return enhStack;
}
