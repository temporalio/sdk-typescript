import { temporal } from '@temporalio/proto';

/**
 * Operations that can be passed to {@link WorkflowClient.updateWorkerBuildIdCompatability}.
 *
 * See the static methods on {@link BuildIdOperations} to construct and for usage info.
 */
export type BuildIdOperation =
  | NewIdInNewDefaultSet
  | NewCompatibleVersion
  | PromoteSetByBuildId
  | PromoteBuildIdWithinSet
  | MergeSets;

interface NewIdInNewDefaultSet {
  _type: 'NewIdInNewDefaultSet';
  buildId: string;
}

interface NewCompatibleVersion {
  _type: 'NewCompatibleVersion';
  buildId: string;
  existingCompatibleBuildId: string;
  makeSetDefault: boolean;
}

interface PromoteSetByBuildId {
  _type: 'PromoteSetByBuildId';
  buildId: string;
}

interface PromoteBuildIdWithinSet {
  _type: 'PromoteBuildIdWithinSet';
  buildId: string;
}

interface MergeSets {
  _type: 'MergeSets';
  primaryBuildId: string;
  secondaryBuildId: string;
}

export class BuildIdOperations {
  /**
   * This operation adds a new Build Id into a new set, which will be used as the default set for
   * the queue. This means all new workflows will start on this Build Id.
   */
  public static newIdInNewDefaultSet(buildId: string): NewIdInNewDefaultSet {
    return { _type: 'NewIdInNewDefaultSet', buildId };
  }

  /**
   * This operation adds a new Build Id into an existing compatible set. The newly added ID becomes
   * the default for that compatible set, and thus new workflow tasks for workflows which have been
   * executing on workers in that set will now start on this new Build Id.
   *
   * @param buildId The Build Id to add to an existing compatible set.
   * @param existingCompatibleBuildId A Build Id which must already be defined on the task queue,
   *     and is used to find the compatible set to add the new ID to.
   * @param makeSetDefault If set to true, the targeted set will also be promoted to become the
   *     overall default set for the queue.
   */
  public static newCompatibleVersion(
    buildId: string,
    existingCompatibleBuildId: string,
    makeSetDefault?: boolean
  ): NewCompatibleVersion {
    return {
      _type: 'NewCompatibleVersion',
      buildId,
      existingCompatibleBuildId,
      makeSetDefault: makeSetDefault ?? false,
    };
  }

  public static promoteSetByBuildId(buildId: string): PromoteSetByBuildId {
    return { _type: 'PromoteSetByBuildId', buildId };
  }

  public static promoteBuildIdWithinSet(buildId: string): PromoteBuildIdWithinSet {
    return { _type: 'PromoteBuildIdWithinSet', buildId };
  }

  public static mergeSets(primaryBuildId: string, secondaryBuildId: string): MergeSets {
    return { _type: 'MergeSets', primaryBuildId, secondaryBuildId };
  }
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
