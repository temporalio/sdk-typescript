/**
 * Represents the version of a specific worker deployment.
 *
 * @experimental Worker deployments are experimental
 */
export interface WorkerDeploymentVersion {
  readonly buildId: string;
  readonly deploymentName: string;
}

export function toCanonicalString(version: WorkerDeploymentVersion): string {
  return `${version.deploymentName}.${version.buildId}`;
}

export type VersioningBehavior = 'pinned' | 'auto-upgrade';
