import type { RetryPolicy } from '@temporalio/common';
import * as workflow from '@temporalio/workflow';

export async function getRetryPolicyFromActivityInfo(
  retryPolicy: RetryPolicy,
  fromInsideLocal: boolean
): Promise<object | undefined> {
  return await (fromInsideLocal
    ? workflow.proxyLocalActivities({ startToCloseTimeout: '1m', retry: retryPolicy }).retryPolicy()
    : workflow.proxyActivities({ startToCloseTimeout: '1m', retry: retryPolicy }).retryPolicy());
}
