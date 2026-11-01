import {
  executeChild,
  InvalidVersioningOverrideError,
  startChild,
  type VersioningOverride,
} from '@temporalio/workflow';

export async function childWorkflowVersioningOverride(
  versioningOverride: VersioningOverride | undefined,
  useStartChild: boolean
): Promise<unknown> {
  const options = { workflowId: 'child-workflow', versioningOverride };
  try {
    if (useStartChild) {
      const child = await startChild('successString', options);
      return await child.result();
    }
    return await executeChild('successString', options);
  } catch (err) {
    if (err instanceof InvalidVersioningOverrideError) {
      return 'invalid versioning override';
    }
    throw err;
  }
}
