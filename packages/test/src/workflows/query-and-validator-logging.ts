import * as wf from '@temporalio/workflow';
import { CustomLoggerSinks } from './log-sink-tester';
import { unblockSignal } from './definitions';

const { customLogger } = wf.proxySinks<CustomLoggerSinks>();

export const loggingQuery = wf.defineQuery<string>('loggingQuery');
export const loggingUpdate = wf.defineUpdate<string, [string]>('loggingUpdate');

export async function queryAndValidatorLogging(): Promise<string> {
  let lastSignal = '';
  let updateArg = '';

  wf.setHandler(loggingQuery, () => {
    customLogger.info('Query handler called');
    return lastSignal;
  });

  wf.setHandler(
    loggingUpdate,
    (arg: string) => {
      customLogger.info('Update handler called');
      updateArg = arg;
      return `update-result: ${arg}`;
    },
    {
      validator: (arg: string) => {
        customLogger.info('Update validator called');
        if (arg === 'bad') {
          throw new Error('Validation failed');
        }
      },
    }
  );

  wf.setHandler(unblockSignal, () => {
    lastSignal = 'unblocked';
  });

  await wf.condition(() => lastSignal === 'unblocked');
  return updateArg
}
