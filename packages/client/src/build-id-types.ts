import { temporal } from '@temporalio/proto';

/**
 * Operations that can be passed to {@link TaskQueueClient.updateBuildIdCompatibility}.
 *
 * @experimental
 */
export type BuildIdOperation =
  | AddNewIdInNewDefaultSet
  | AddNewCompatibleVersion
  | PromoteSetByBuildId
  | PromoteBuildIdWithinSet
  | MergeSets;

/**
 * Adds a new Build Id into a new set, which will be used as the default set for
 * the queue. This means all new workflows will start on this Build Id.
 *
 * @experimental
 */
export interface AddNewIdInNewDefaultSet {
  operation: 'addNewIdInNewDefaultSet';
  buildId: string;
}

/**
 * Adds a new Build Id into an existing compatible set. The newly added ID becomes
 * the default for that compatible set, and thus new workflow tasks for workflows which have been
 * executing on workers in that set will now start on this new Build Id.
 *
 * @experimental
 */
export interface AddNewCompatibleVersion {
  operation: 'addNewCompatibleVersion';
  // The Build Id to add to an existing compatible set.
  buildId: string;
  // A Build Id which must already be defined on the task queue, and is used to
  // find the compatible set to add the new id to.
  existingCompatibleBuildId: string;
  // If set to true, the targeted set will also be promoted to become the
  // overall default set for the queue.
  promoteSet?: boolean;
}

/**
 * Promotes a set of compatible Build Ids to become the current
 * default set for the task queue. Any Build Id in the set may be used to
 * target it.
 *
 * @experimental
 */
export interface PromoteSetByBuildId {
  operation: 'promoteSetByBuildId';
  buildId: string;
}

/**
 * Promotes a Build Id within an existing set to become the default ID for that
 * set.
 *
 * @experimental
 */
export interface PromoteBuildIdWithinSet {
  operation: 'promoteBuildIdWithinSet';
  buildId: string;
}

/**
 * Merges two sets into one set, thus declaring all the Build Ids in both as
 * compatible with one another. The default of the primary set is maintained as
 * the merged set's overall default.
 *
 * @experimental
 */
export interface MergeSets {
  operation: 'mergeSets';
  // A Build Id which is used to find the primary set to be merged.
  primaryBuildId: string;
  // A Build Id which is used to find the secondary set to be merged.
  secondaryBuildId: string;
}

/**
 * Represents the sets of compatible Build Id versions associated with some
 * Task Queue, as fetched by {@link TaskQueueClient.getBuildIdCompatability}.
 *
 * @experimental
 */
export interface WorkerBuildIdVersionSets {
  /**
   * All version sets that were fetched for this task queue.
   */
  readonly versionSets: BuildIdVersionSet[];

  /**
   * Returns the default set of compatible Build Ids for the task queue these sets are
   * associated with.
   */
  defaultSet: BuildIdVersionSet;

  /**
   * Returns the overall default Build Id for the task queue these sets are
   * associated with.
   */
  defaultBuildId: string;
}

/**
 * Represents one set of compatible Build Ids.
 *
 * @experimental
 */
export interface BuildIdVersionSet {
  // All build IDs contained in the set.
  readonly buildIds: string[];

  // Returns the default Build Id for this set
  readonly default: string;
}

export function versionSetsFromProto(
  resp: temporal.api.workflowservice.v1.GetWorkerBuildIdCompatibilityResponse
): WorkerBuildIdVersionSets {
  if (resp == null || resp.majorVersionSets == null || resp.majorVersionSets.length === 0) {
    throw new Error('Must be constructed from a compatability response with at least one version set');
  }
  return {
    versionSets: resp.majorVersionSets.map((set) => versionSetFromProto(set)),
    get defaultSet(): BuildIdVersionSet {
      return this.versionSets[this.versionSets.length - 1];
    },
    get defaultBuildId(): string {
      return this.defaultSet.default;
    },
  };
}

function versionSetFromProto(set: temporal.api.taskqueue.v1.ICompatibleVersionSet): BuildIdVersionSet {
  if (set == null || set.buildIds == null || set.buildIds.length === 0) {
    throw new Error('Compatible version sets must contain at least one Build Id');
  }
  return {
    buildIds: set.buildIds,
    default: set.buildIds[set.buildIds.length - 1],
  };
}
