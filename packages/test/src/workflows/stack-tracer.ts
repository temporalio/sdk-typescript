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
  const first = await Promise.race([
    queryOwnWf(wf.stackTraceQuery),
    wf.executeChild(unblockOrCancel) as any,
    wf.sleep(10000) as any,
    new wf.Trigger<string>(),
  ]);
  const second = await queryOwnWf(wf.stackTraceQuery);
  return [first, second];
}
