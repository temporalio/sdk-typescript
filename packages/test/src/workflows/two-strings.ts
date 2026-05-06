import type { Sinks } from '@temporalio/workflow';
import { proxyActivities, proxySinks } from '@temporalio/workflow';
import type { createConcatActivity } from '../activities/create-concat-activity';

export interface LogSinks extends Sinks {
  logger: {
    log(message: string): void;
  };
}

const { logger } = proxySinks<LogSinks>();

const { concat } = proxyActivities<ReturnType<typeof createConcatActivity>>({ startToCloseTimeout: '1s' });

export async function twoStrings(string1: string, string2: string): Promise<string> {
  logger.log(string1 + string2);
  return string1 + string2;
}

export async function twoStringsActivity(): Promise<string> {
  const result = await concat('str1', 'str2');
  logger.log(result);
  return result;
}
