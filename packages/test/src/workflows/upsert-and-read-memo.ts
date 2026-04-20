import { upsertMemo, workflowInfo, proxySinks } from '@temporalio/workflow';
import type { CustomLoggerSinks } from './log-sink-tester';

const { customLogger } = proxySinks<CustomLoggerSinks>();

export async function upsertAndReadMemo(memo: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  customLogger.info('Before upsert memo');
  upsertMemo(memo);
  customLogger.info('After upsert memo');
  return workflowInfo().memo;
}
