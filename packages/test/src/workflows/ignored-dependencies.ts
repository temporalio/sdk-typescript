// Run all different kinds of ignored dependency functions to check that the Worker reports when they throw
import { dependencies } from '@temporalio/workflow';
import { Returner } from '../interfaces';
import { IgnoredTestDependencies } from '../interfaces/dependencies';

const { syncIgnored, asyncIgnored } = dependencies<IgnoredTestDependencies>();

async function execute(): Promise<number> {
  let i = 0;
  syncIgnored.syncImpl(i++);
  syncIgnored.asyncImpl(i++);
  asyncIgnored.syncImpl(i++);
  asyncIgnored.asyncImpl(i++);
  return i;
}

export const ignoredDependencies: Returner<number> = () => ({ execute });
