/**
 * Tests that cancellation scopes are correctly associated when resumed after completion
 *
 * @module
 */

import { Context, shield } from '@temporalio/workflow';
import { httpGet } from '@activities';

export async function main(url: string): Promise<any> {
  const result = await shield(async () => {
    return [
      await httpGet(url),
      await httpGet(url), // <-- This activity should still be shielded
    ];
  }, false /* Don't throw on cancellation */);
  if (Context.cancelled) {
    console.log('Workflow cancelled while waiting on shielded scope');
  }
  return result;
}
