const WORKFLOW_BUNDLE_ANNOTATION_PREFIX = '/* @temporalio/workflow-bundle ';
const WORKFLOW_BUNDLE_ANNOTATION_SUFFIX = ' */';

interface WorkflowBundleMetadata {
  sdkVersion: string;
}

function invalidWorkflowBundleVersionAnnotation(): TypeError {
  return new TypeError(
    `The provided Workflow Bundle contains an invalid Temporal SDK version annotation. ` +
      `Rebuild the bundle with the same version of '@temporalio/worker' that is being used to create the Worker.`
  );
}

export function makeWorkflowBundleVersionAnnotation(sdkVersion: string, executionMode: 'vm' | 'vmless' = 'vm'): string {
  const metadata = executionMode === 'vm' ? { sdkVersion } : { sdkVersion, executionMode };
  return `${WORKFLOW_BUNDLE_ANNOTATION_PREFIX}${JSON.stringify(metadata)}${WORKFLOW_BUNDLE_ANNOTATION_SUFFIX}`;
}

export function assertWorkflowBundleExecutionMode(code: string, expected: 'vm' | 'vmless'): void {
  // Validate the annotation before parsing its optional execution-mode field.
  getWorkflowBundleSdkVersion(code);
  const line = code.split('\n', 1)[0]!.replace(/\r$/, '');
  const metadata = JSON.parse(
    line.slice(WORKFLOW_BUNDLE_ANNOTATION_PREFIX.length, -WORKFLOW_BUNDLE_ANNOTATION_SUFFIX.length)
  );
  const actual = metadata.executionMode ?? 'vm';
  if (actual !== expected) {
    throw new TypeError(`Workflow bundle execution mode '${actual}' does not match Worker mode '${expected}'`);
  }
}

export function getWorkflowBundleSdkVersion(code: string): string {
  const firstLineEnd = code.indexOf('\n');
  const firstLine = code.slice(0, firstLineEnd === -1 ? code.length : firstLineEnd).replace(/\r$/, '');

  if (!firstLine.startsWith(WORKFLOW_BUNDLE_ANNOTATION_PREFIX)) {
    throw new TypeError(
      `The provided Workflow Bundle does not contain a Temporal SDK version annotation. ` +
        `Make sure the bundle was generated with the same version of '@temporalio/worker' that is being used to ` +
        `create the Worker.`
    );
  }

  if (!firstLine.endsWith(WORKFLOW_BUNDLE_ANNOTATION_SUFFIX)) {
    throw invalidWorkflowBundleVersionAnnotation();
  }

  const serializedMetadata = firstLine.slice(
    WORKFLOW_BUNDLE_ANNOTATION_PREFIX.length,
    -WORKFLOW_BUNDLE_ANNOTATION_SUFFIX.length
  );
  let metadata: WorkflowBundleMetadata;
  try {
    metadata = JSON.parse(serializedMetadata);
  } catch (_err) {
    throw invalidWorkflowBundleVersionAnnotation();
  }

  if (typeof metadata !== 'object' || metadata === null || typeof metadata.sdkVersion !== 'string') {
    throw invalidWorkflowBundleVersionAnnotation();
  }

  return metadata.sdkVersion;
}

export function assertWorkflowBundleSdkVersion(code: string, expectedSdkVersion: string): void {
  const actualSdkVersion = getWorkflowBundleSdkVersion(code);
  if (actualSdkVersion !== expectedSdkVersion) {
    throw new TypeError(
      `The provided Workflow Bundle was generated with Temporal SDK version '${actualSdkVersion}', but the Worker ` +
        `is running version '${expectedSdkVersion}'. The Workflow Bundle and Worker must use exactly the same SDK ` +
        `version. Rebuild the bundle with the same version of '@temporalio/worker' that is being used to create the ` +
        `Worker.`
    );
  }
}
