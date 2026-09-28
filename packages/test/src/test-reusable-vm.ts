import test from 'ava';
import { bundleWorkflowCode } from '@temporalio/worker';
import { ReusableVMWorkflowCreator } from '@temporalio/worker/internal/workflow/reusable-vm';
import { parseWorkflowCode } from '@temporalio/worker/internal/worker';

test('reusable sandbox can release its shared AsyncLocalStorage instances', async (t) => {
  const bundle = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows/success-string') });
  const creator = await ReusableVMWorkflowCreator.create(parseWorkflowCode(bundle.code), 4000, new Set());

  await t.notThrowsAsync(() => creator.destroy());
});
