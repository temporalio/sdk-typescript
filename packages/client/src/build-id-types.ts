import { temporal } from '@temporalio/proto';

/**
 * Operations that can be passed to {@link WorkflowClient.updateWorkerBuildIdCompatability}.
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
 */
interface NewIdInNewDefaultSet {
  operation: 'NEW_ID_IN_NEW_DEFAULT_SET';
  buildId: string;
}

/**
 * This operation adds a new Build Id into an existing compatible set. The newly added ID becomes
 * the default for that compatible set, and thus new workflow tasks for workflows which have been
 * executing on workers in that set will now start on this new Build Id.
 *
 */
interface NewCompatibleVersion {
  operation: 'NEW_COMPATIBLE_VERSION';
  // buildId The Build Id to add to an existing compatible set.
  buildId: string;
  // A Build Id which must already be defined on the task queue, and is used to
  // find the compatible set to add the new ID to.
  existingCompatibleBuildId: string;
  // If set to true, the targeted set will also be promoted to become the
  // overall default set for the queue.
  makeSetDefault?: boolean;
}

interface PromoteSetByBuildId {
  operation: 'PROMOTE_SET_BY_BUILD_ID';
  buildId: string;
}

interface PromoteBuildIdWithinSet {
  operation: 'PROMOTE_BUILD_ID_WITHIN_SET';
  buildId: string;
}

interface MergeSets {
  operation: 'MERGE_SETS';
  primaryBuildId: string;
  secondaryBuildId: string;
}

export class WorkerBuildIdVersionSets {
  public readonly versionSets: BuildIdVersionSet[];

  constructor(resp: temporal.api.workflowservice.v1.GetWorkerBuildIdCompatibilityResponse) {
    if (resp == null || resp.majorVersionSets == null || resp.majorVersionSets.length === 0) {
      throw new Error('Must be constructed froma a compatability response with at least one version set');
    }
    this.versionSets = resp.majorVersionSets.map((set) => new BuildIdVersionSet(set));
  }

  public defaultSet(): BuildIdVersionSet {
    return new BuildIdVersionSet(this.versionSets[this.versionSets.length - 1]);
  }

  public defaultBuildId(): string {
    return this.defaultSet().default();
  }
}

export class BuildIdVersionSet {
  public readonly buildIds: string[];

  constructor(set: temporal.api.taskqueue.v1.ICompatibleVersionSet) {
    if (set == null || set.buildIds == null || set.buildIds.length === 0) {
      throw new Error('Compatible version sets must contain at least one Build ID');
    }
    this.buildIds = set.buildIds;
  }

  public default(): string {
    return this.buildIds[this.buildIds.length - 1];
  }
}
