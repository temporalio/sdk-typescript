// @@@SNIPSTART typescript-workflow-signal-implementation
import { defineSignal, setHandler } from '@temporalio/workflow';

export const interruptSignal = defineSignal<[string]>('interrupt');

export async function interruptableWorkflow(): Promise<void> {
  // When this Promise is rejected Workflow execution will fail
  await new Promise<never>((_resolve, reject) => {
    setHandler(interruptSignal, (reason) => reject(new Error(reason)));
  });
}
// @@@SNIPEND
