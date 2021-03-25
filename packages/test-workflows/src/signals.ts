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
  await Promise.race([
    new Promise((_resolve, reject) => {
      interrupt = reject;
    }),
    sleep(100000),
  ]);
}

export const workflow: Interruptable = { main, signals };
