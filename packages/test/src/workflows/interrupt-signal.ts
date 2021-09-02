// @@@SNIPSTART nodejs-workflow-signal-implementation
import { Interruptable } from '../interfaces';

let interrupt: (reason?: any) => void | undefined;

const signals = {
  // Interrupt execute by rejecting the awaited Promise
  interrupt(reason: string): void {
    if (interrupt !== undefined) {
      interrupt(new Error(reason));
    }
  },
};

async function execute(): Promise<void> {
  // When this Promise is rejected the Workflow execution will fail
  await new Promise<never>((_resolve, reject) => {
    interrupt = reject;
  });
}

export const interruptSignal: Interruptable = () => ({ execute, signals });
// @@@SNIPEND
