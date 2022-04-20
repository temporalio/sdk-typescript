import { defineSignal, setHandler, ApplicationFailure } from '@temporalio/workflow';

export const interruptSignal = defineSignal<[string]>('interrupt');

export async function interruptableWorkflow(): Promise<void> {
  // When this Promise is rejected Workflow execution will fail
  await new Promise<never>((_resolve, reject) => {
    setHandler(interruptSignal, (reason) => reject(ApplicationFailure.retryable(reason)));
  });
}
