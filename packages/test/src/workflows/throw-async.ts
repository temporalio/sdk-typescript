import '@temporalio/workflow';

export async function main(): Promise<never> {
  throw new Error('failure');
}
