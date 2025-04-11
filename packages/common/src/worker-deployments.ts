/**
 * Represents the version of a specific worker deployment.
 *
 * @experimental Worker deployments are experimental
 */
export interface WorkerDeploymentVersion {
  buildId: string;
  deploymentName: string;
}

export type VersioningBehavior = 'pinned' | 'auto-upgrade';
