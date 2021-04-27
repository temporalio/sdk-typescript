import { sleep } from '@temporalio/workflow';
import { Interruptable } from '@interfaces';

let interrupt: (reason?: any) => void | undefined;

const signals = {
  interrupt(reason: string): void {
    if (interrupt !== undefined) {
      interrupt(new Error(reason));
    }
  },
  fail(): never {
    throw new Error('Signal failed');
  },
};

async function main(): Promise<void> {
  try {
    await Promise.race([
      new Promise<never>((_resolve, reject) => {
        interrupt = reject;
      }),
      (async (): Promise<never> => {
        await sleep(100000);
        throw new Error('Sleep completed unexpectedly');
      })(),
    ]);
  } catch (err) {
    if (err.message !== 'just because') {
      throw new Error('Unexpected error');
    }
  }
  // Don't complete to allow Workflow to be interrupted by fail() signal
  await sleep(100000);
}

export const workflow: Interruptable = { main, signals };
