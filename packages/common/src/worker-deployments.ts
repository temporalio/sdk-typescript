import type { temporal } from '@temporalio/proto';
import { makeProtoEnumConverters } from './internal-workflow';

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
 * * 'PINNED' - The workflow will be pinned to the current Build ID unless manually moved.
 * * 'AUTO_UPGRADE' - The workflow will automatically move to the latest version (default Build ID
 *    of the task queue) when the next task is dispatched.
 *
 * @experimental Deployment based versioning is experimental and may change in the future.
 */
export const VersioningBehavior = {
  PINNED: 'PINNED',
  AUTO_UPGRADE: 'AUTO_UPGRADE',
} as const;
export type VersioningBehavior = (typeof VersioningBehavior)[keyof typeof VersioningBehavior];

export const [encodeVersioningBehavior, decodeVersioningBehavior] = makeProtoEnumConverters<
  temporal.api.enums.v1.VersioningBehavior,
  typeof temporal.api.enums.v1.VersioningBehavior,
  keyof typeof temporal.api.enums.v1.VersioningBehavior,
  typeof VersioningBehavior,
  'VERSIONING_BEHAVIOR_'
>(
  {
    [VersioningBehavior.PINNED]: 1,
    [VersioningBehavior.AUTO_UPGRADE]: 2,
    UNSPECIFIED: 0,
  } as const,
  'VERSIONING_BEHAVIOR_'
);

/**
 * Represents versioning overrides. For example, when starting workflows.
 */
export type VersioningOverride = PinnedVersioningOverride | 'AUTO_UPGRADE';

/**
 * Workflow will be pinned to a specific deployment version.
 */
export interface PinnedVersioningOverride {
  /**
   * The worker deployment version to pin the workflow to.
   */
  pinnedTo: WorkerDeploymentVersion;
}

/**
 * The workflow will auto-upgrade to the current deployment version on the next workflow task.
 */
export type AutoUpgradeVersioningOverride = 'AUTO_UPGRADE';
