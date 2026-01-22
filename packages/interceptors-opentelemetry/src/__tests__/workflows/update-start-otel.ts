import * as workflow from '@temporalio/workflow';

export const otelUpdate = workflow.defineUpdate<boolean, [boolean]>('otelUpdate');

export async function updateStartOtel(): Promise<boolean> {
  let updateResult = false;
  workflow.setHandler(otelUpdate, (value: boolean): boolean => {
    updateResult = value;
    return true;
  });
  return updateResult;
}
