import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

const { observeBaggage } = proxyActivities<typeof activities>({ startToCloseTimeout: '1 minute' });

/**
 * Returns the baggage the Activity observes, exercising both the client -> Workflow and
 * Workflow -> Activity baggage-propagation hops.
 */
export async function baggagePropagation(): Promise<Record<string, string>> {
  return await observeBaggage();
}
