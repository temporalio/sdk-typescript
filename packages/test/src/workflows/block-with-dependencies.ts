import { Context, ExternalDependencies, CancellationScope } from '@temporalio/workflow';
import { Empty } from '../interfaces';

export interface Deps extends ExternalDependencies {
  blocker: {
    block(): Promise<void>;
  };
}

async function execute(): Promise<void> {
  console.log('blocking');
  const { blocker } = Context.dependencies<Deps>();
  await blocker.block();
  console.log('unblocked');
  await CancellationScope.current().cancelRequested;
}

export const blockWithDependencies: Empty = () => ({ execute });
