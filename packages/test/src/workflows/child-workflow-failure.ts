/**
 * Tests child workflow failure from the parent workflow perspective
 * @module
 */

import { Context } from '@temporalio/workflow';
import * as throwAsync from './throw-async';

export async function main(): Promise<void> {
  const child = Context.child<typeof throwAsync>('throw-async', {
    taskQueue: 'test',
  });
  await child.execute();
}
