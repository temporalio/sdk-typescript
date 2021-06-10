// @@@SNIPSTART nodejs-shield-awaited-in-root-scope
import { CancellationScope } from '@temporalio/workflow';
import { httpGetJSON } from '@activities';

export async function main(): Promise<any> {
  let p: Promise<any> | undefined = undefined;

  await CancellationScope.nonCancellable(async () => {
    p = httpGetJSON('http://example.com'); // <-- Start activity in nonCancellable scope without awaiting completion
  });
  // Activity is shielded from cancellation even though it is awaited in the cancellable root scope
  return p;
}
// @@@SNIPEND
