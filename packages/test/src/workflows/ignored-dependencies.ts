// Run all different kinds of ignored dependency functions to check that the Worker reports when they throw
import { Context } from '@temporalio/workflow';
import { IgnoredTestDependencies } from '../interfaces/dependencies';

const { syncIgnored, asyncIgnored } = Context.dependencies<IgnoredTestDependencies>();

export async function execute(): Promise<number> {
  let i = 0;
  syncIgnored.syncImpl(i++);
  syncIgnored.asyncImpl(i++);
  asyncIgnored.syncImpl(i++);
  asyncIgnored.asyncImpl(i++);
  return i;
}
