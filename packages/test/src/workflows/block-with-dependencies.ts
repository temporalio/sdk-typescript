import { dependencies, ExternalDependencies, CancellationScope } from '@temporalio/workflow';

export interface Deps extends ExternalDependencies {
  blocker: {
    block(): Promise<void>;
  };
}

export async function blockWithDependencies(): Promise<void> {
  console.log('blocking');
  const { blocker } = dependencies<Deps>();
  await blocker.block();
  console.log('unblocked');
  await CancellationScope.current().cancelRequested;
}
