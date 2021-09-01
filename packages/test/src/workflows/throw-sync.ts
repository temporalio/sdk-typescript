import '@temporalio/workflow';

export function execute(): never {
  throw new Error('failure');
}
