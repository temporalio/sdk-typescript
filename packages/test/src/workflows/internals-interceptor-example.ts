import { dependencies, WorkflowInterceptors, ExternalDependencies, sleep } from '@temporalio/workflow';

export interface Dependencies extends ExternalDependencies {
  logger: {
    log(event: string): void;
  };
}

const { logger } = dependencies<Dependencies>();

export async function internalsInterceptorExample(): Promise<void> {
  await sleep(10);
}

export const interceptors = (): WorkflowInterceptors => ({
  internals: [
    {
      activate(input, next) {
        logger.log(`activate: ${input.batchIndex}`);
        return next(input);
      },
    },
    {
      concludeActivation(input, next) {
        logger.log(`concludeActivation: ${input.commands.length}`);
        return next(input);
      },
    },
  ],
  inbound: [],
  outbound: [],
});
