// @@@SNIPSTART nodejs-workflow-signal-implementation
import { Interruptable } from '@interfaces';

let interrupt: (reason?: any) => void | undefined;

const signals = {
  // Interrupt main by rejecting the awaited Promise
  interrupt(reason: string): void {
    if (interrupt !== undefined) {
      interrupt(new Error(reason));
    }
  },
};

async function main(): Promise<void> {
  // When this Promise is rejected the Workflow execution will fail
  await new Promise<never>((_resolve, reject) => {
    interrupt = reject;
  });
}

export const workflow: Interruptable = { main, signals };
// @@@SNIPEND
