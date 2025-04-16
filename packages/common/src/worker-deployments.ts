/**
 * Represents the version of a specific worker deployment.
 *
 * @experimental Deployment based versioning is experimental and may change in the future.
 */
export interface WorkerDeploymentVersion {
  readonly buildId: string;
  readonly deploymentName: string;
}

/**
 * @returns The canonical representation of a deployment version, which is a string in the format
 * `deploymentName.buildId`.
 */
export function toCanonicalString(version: WorkerDeploymentVersion): string {
  return `${version.deploymentName}.${version.buildId}`;
}

/**
 * Specifies when a workflow might move from a worker of one Build Id to another.
 *
 * * 'pinned' - The workflow will be pinned to the current Build ID unless manually moved.
 * * 'auto-upgrade' - The workflow will automatically move to the latest version (default Build ID
 *    of the task queue) when the next task is dispatched.
 *
 * @experimental Deployment based versioning is experimental and may change in the future.
 */
export type VersioningBehavior = 'pinned' | 'auto-upgrade';
