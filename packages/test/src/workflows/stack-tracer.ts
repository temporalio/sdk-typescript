/**
 * Workflow used in integration-tests: `Stack trace query returns stack that makes sense`
 * @module
 */
import * as wf from '@temporalio/workflow';
import { EnhancedStackTrace } from '@temporalio/workflow/src/interfaces';
import type * as activities from '../activities';
import { unblockOrCancel } from './unblock-or-cancel';

const { queryOwnWf } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

export async function stackTracer(): Promise<[string, string]> {
  const trigger = new wf.Trigger<string>();

  const [first] = await Promise.all([
    trigger,
    Promise.race([
      queryOwnWf(wf.stackTraceQuery).then((stack) => trigger.resolve(stack)),
      wf.executeChild(unblockOrCancel),
      wf.sleep(100_000),
    ]),
  ]);
  const second = await queryOwnWf(wf.stackTraceQuery);
  return [first, second];
}

export async function enhancedStackTracer(): Promise<[EnhancedStackTrace, EnhancedStackTrace]> {
  const trigger = new wf.Trigger<EnhancedStackTrace>();

  const [first] = await Promise.all([
    trigger,
    Promise.race([
      queryOwnWf(wf.enhancedStackTraceQuery).then((stack) => trigger.resolve(stack)),
      wf.executeChild(unblockOrCancel),
      wf.sleep(100_000),
    ]),
  ]);
  const second = await queryOwnWf(wf.enhancedStackTraceQuery);
  void wf.sleep(100_000_000);
  return [first, second];
}
