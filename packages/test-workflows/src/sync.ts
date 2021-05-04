import '@temporalio/workflow';

let i = 0;

export function main(): string {
  return 'success' + i++;
}
