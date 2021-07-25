/**
 * Tests the happy path of starting and awaiting a child workflow
 * @module
 */

import { Context } from '@temporalio/workflow';
import * as sync from './sync';

export async function main(): Promise<{ workflowId: string; runId: string; execResult: string; result: string }> {
  const child = Context.child<typeof sync>('sync', {
    taskQueue: 'test',
  });
  const execResult = await Context.child<typeof sync>('sync', {
    taskQueue: 'test',
  }).execute();
  return { workflowId: child.workflowId, runId: await child.start(), result: await child.result(), execResult };
}
