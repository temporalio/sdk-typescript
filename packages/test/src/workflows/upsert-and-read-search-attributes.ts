import { SearchAttributes, upsertSearchAttributes, workflowInfo } from '@temporalio/workflow';

export async function upsertAndReadSearchAttributes(msSinceEpoch: number): Promise<SearchAttributes | undefined> {
  upsertSearchAttributes({
    CustomIntField: [123],
    CustomBoolField: [true],
  });
  upsertSearchAttributes({
    CustomIntField: [], // clear
    CustomKeywordField: ['durable code'],
    CustomTextField: ['is useful'],
    CustomDatetimeField: [new Date(msSinceEpoch)],
    CustomDoubleField: [3.14],
  });
  return workflowInfo().searchAttributes;
}
