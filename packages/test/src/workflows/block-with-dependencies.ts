import { Context, ExternalDependencies, CancellationScope } from '@temporalio/workflow';

export interface Deps extends ExternalDependencies {
  blocker: {
    block(): Promise<void>;
  };
}

async function main(): Promise<void> {
  console.log('blocking');
  const { blocker } = Context.dependencies<Deps>();
  await blocker.block();
  console.log('unblocked');
  await CancellationScope.current().cancelRequested;
}

export const workflow = { main };
