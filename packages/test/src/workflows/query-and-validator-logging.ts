import * as wf from '@temporalio/workflow';
import { unblockSignal } from './definitions';

export const loggingQuery = wf.defineQuery<string>('loggingQuery');
export const loggingUpdate = wf.defineUpdate<string, [string]>('loggingUpdate');

export async function queryAndValidatorLogging(): Promise<void> {
  let lastSignal = '';

  wf.setHandler(loggingQuery, () => {
    wf.log.info('Query handler called');
    return lastSignal;
  });

  wf.setHandler(
    loggingUpdate,
    (arg: string) => {
      wf.log.info('Update handler called');
      return `update-result: ${arg}`;
    },
    {
      validator: (arg: string) => {
        wf.log.info('Update validator called');
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
}
