/**
 * Tests continueAsNew to another Workflow
 * @module
 */
import { Context } from '@temporalio/workflow';
import { Empty, Sleeper } from '../interfaces';

async function main(): Promise<void> {
  const continueAsNew = Context.makeContinueAsNewFunc<Sleeper['main']>({ workflowType: 'sleep' });
  await continueAsNew(1);
}

export const workflow: Empty = { main };
