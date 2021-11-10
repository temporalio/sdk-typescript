import { patched } from '@temporalio/workflow';

const startupErrors: string[] = [];

try {
  patched('should-sleep');
} catch (err: any) {
  startupErrors.push(err.message);
}

export async function patchedTopLevel(): Promise<void> {
  console.log(startupErrors);
}
