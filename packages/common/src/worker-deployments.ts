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

/**
 * Defines the versioning behavior to be used by the first task of a new workflow run in a continue-as-new chain.
 * 
 * AUTO_UPGRADE - Start the new run with AutoUpgrade behavior. Use the Target Version of the workflow's task queue at
    start-time, as AutoUpgrade workflows do. After the first workflow task completes, use whatever
    Versioning Behavior the workflow is annotated with in the workflow code.
    
    Note that if the previous workflow had a Pinned override, that override will be inherited by the
    new workflow run regardless of the ContinueAsNewVersioningBehavior specified in the continue-as-new
    command. If a Pinned override is inherited by the new run, and the new run starts with AutoUpgrade
    behavior, the base version of the new run will be the Target Version as described above, but the
    effective version will be whatever is specified by the Versioning Override until the override is removed.
 * 
 * @experimental Versioning semantics with continue-as-new are experimental and may change in the future.
 */
export const InitialVersioningBehavior = {
  AUTO_UPGRADE: 'AUTO_UPGRADE',
} as const;
export type InitialVersioningBehavior = (typeof InitialVersioningBehavior)[keyof typeof InitialVersioningBehavior];

export const [encodeInitialVersioningBehavior, decodeInitialVersioningBehavior] = makeProtoEnumConverters<
  temporal.api.enums.v1.ContinueAsNewVersioningBehavior,
  typeof temporal.api.enums.v1.ContinueAsNewVersioningBehavior,
  keyof typeof temporal.api.enums.v1.ContinueAsNewVersioningBehavior,
  typeof InitialVersioningBehavior,
  'CONTINUE_AS_NEW_VERSIONING_BEHAVIOR_'
>(
  {
    [InitialVersioningBehavior.AUTO_UPGRADE]: 1,
    UNSPECIFIED: 0,
  } as const,
  'CONTINUE_AS_NEW_VERSIONING_BEHAVIOR_'
);
