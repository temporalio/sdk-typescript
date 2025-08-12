import { SearchAttributes, upsertSearchAttributes, workflowInfo, proxySinks } from '@temporalio/workflow';
import { CustomLoggerSinks } from './log-sink-tester';

const { customLogger } = proxySinks<CustomLoggerSinks>();

// eslint-disable-next-line deprecation/deprecation
export async function upsertAndReadSearchAttributes(msSinceEpoch: number): Promise<SearchAttributes | undefined> {
  customLogger.info('Before upsert');
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
  customLogger.info('After upsert');
  return workflowInfo().searchAttributes; // eslint-disable-line deprecation/deprecation
}
