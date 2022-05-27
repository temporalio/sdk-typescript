import { SearchAttributeValue, workflowInfo } from '@temporalio/workflow';

export async function returnSearchAttributes(): Promise<Record<string, SearchAttributeValue[]> | undefined> {
  const sa = workflowInfo().searchAttributes!; // eslint-disable-line @typescript-eslint/no-non-null-assertion
  const datetime = (sa.CustomDatetimeField as Array<Date>)[0];
  return {
    ...sa,
    datetimeType: [Object.getPrototypeOf(datetime).constructor.name],
    datetimeInstanceofWorks: [datetime instanceof Date],
  };
}
