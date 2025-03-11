import {
  condition,
  defineSignal,
  setDefaultQueryHandler,
  setDefaultSignalHandler,
  setHandler,
} from '@temporalio/workflow';

export async function workflowWithDefaultHandlers(): Promise<void> {
  const complete = true;
  setDefaultQueryHandler(() => {});
  setDefaultSignalHandler(() => {});
  setHandler(defineSignal('completeSignal'), () => {});

  await condition(() => complete);
}
