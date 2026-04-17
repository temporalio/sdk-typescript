import type { WorkflowInterceptors, Sinks } from '@temporalio/workflow';
import { proxySinks, sleep } from '@temporalio/workflow';

export interface MyLoggerSinks extends Sinks {
  logger: {
    log(event: string): void;
  };
}

const { logger } = proxySinks<MyLoggerSinks>();

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
