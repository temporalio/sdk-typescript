import { proxySinks, WorkflowInterceptors, Sinks, sleep } from '@temporalio/workflow';

export interface LoggerSinks extends Sinks {
  logger: {
    log(event: string): void;
  };
}

const { logger } = proxySinks<LoggerSinks>();

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
