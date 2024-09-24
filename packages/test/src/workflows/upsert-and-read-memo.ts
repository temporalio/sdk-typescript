import { upsertMemo, workflowInfo } from '@temporalio/workflow';

export async function upsertAndReadMemo(memo: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  upsertMemo(memo);
  return workflowInfo().memo;
}
