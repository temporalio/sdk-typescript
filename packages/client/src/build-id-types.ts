import { temporal } from '@temporalio/proto';

/**
 * Operations that can be passed to {@link WorkflowClient.updateWorkerBuildIdCompatability}.
 *
 * @experimental
 */
export type BuildIdOperation =
  | NewIdInNewDefaultSet
  | NewCompatibleVersion
  | PromoteSetByBuildId
  | PromoteBuildIdWithinSet
  | MergeSets;

/**
 * This operation adds a new Build Id into a new set, which will be used as the default set for
 * the queue. This means all new workflows will start on this Build Id.
 *
 * @experimental
 */
interface NewIdInNewDefaultSet {
  operation: 'newIdInNewDefaultSet';
  buildId: string;
}

/**
 * This operation adds a new Build Id into an existing compatible set. The newly added ID becomes
 * the default for that compatible set, and thus new workflow tasks for workflows which have been
 * executing on workers in that set will now start on this new Build ID.
 *
 * @experimental
 */
interface NewCompatibleVersion {
  operation: 'newCompatibleVersion';
  // buildId The Build Id to add to an existing compatible set.
  buildId: string;
  // A Build Id which must already be defined on the task queue, and is used to
  // find the compatible set to add the new ID to.
  existingCompatibleBuildId: string;
  // If set to true, the targeted set will also be promoted to become the
  // overall default set for the queue.
  makeSetDefault?: boolean;
}

/**
 * This operation promotes a set of compatible Build IDs to become the current
 * default set for the task queue. Any Build ID in the set may be used to
 * target it.
 *
 * @experimental
 */
interface PromoteSetByBuildId {
  operation: 'promoteSetByBuildId';
  buildId: string;
}

/**
 * This operation promotes a Build ID within an existing set to become the
 * default ID for that set.
 *
 * @experimental
 */
interface PromoteBuildIdWithinSet {
  operation: 'promoteBuildIdWithinSet';
  buildId: string;
}

/**
 * This operation merges two sets into one set, thus declaring all the Build Ids in both as
 * compatible with one another. The default of the primary set is maintained as the merged set's
 * overall default.
 *
 * @experimental
 */
interface MergeSets {
  operation: 'mergeSets';
  // A Build Id which is used to find the primary set to be merged.
  primaryBuildId: string;
  // A Build Id which is used to find the secondary set to be merged.
  secondaryBuildId: string;
}

/**
 * Represents the sets of compatible Build ID versions associated with some
 * Task Queue, as fetched by {@link WorkflowClient.getWorkerBuildIdCompatability}.
 *
 * @experimental
 */
export class WorkerBuildIdVersionSets {
  public readonly versionSets: BuildIdVersionSet[];

  constructor(resp: temporal.api.workflowservice.v1.GetWorkerBuildIdCompatibilityResponse) {
    if (resp == null || resp.majorVersionSets == null || resp.majorVersionSets.length === 0) {
      throw new Error('Must be constructed from a compatability response with at least one version set');
    }
    this.versionSets = resp.majorVersionSets.map((set) => new BuildIdVersionSet(set));
  }

  /**
   * Returns the default set of compatible Build IDs for the task queue these sets are
   * associated with.
   */
  public defaultSet(): BuildIdVersionSet {
    return new BuildIdVersionSet(this.versionSets[this.versionSets.length - 1]);
  }

  /**
   * Returns the overall default Build ID for the task queue these sets are
   * associated with.
   */
  public defaultBuildId(): string {
    return this.defaultSet().default();
  }
}

/**
 * Represents one set of compatible Build IDs.
 *
 * @experimental
 */
export class BuildIdVersionSet {
  public readonly buildIds: string[];

  constructor(set: temporal.api.taskqueue.v1.ICompatibleVersionSet) {
    if (set == null || set.buildIds == null || set.buildIds.length === 0) {
      throw new Error('Compatible version sets must contain at least one Build ID');
    }
    this.buildIds = set.buildIds;
  }

  /**
   * Returns the default Build ID for this set
   */
  public default(): string {
    return this.buildIds[this.buildIds.length - 1];
  }
}
