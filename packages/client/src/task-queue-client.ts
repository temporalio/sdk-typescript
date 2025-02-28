import { status } from '@grpc/grpc-js';
import { assertNever, SymbolBasedInstanceOfError, RequireAtLeastOne } from '@temporalio/common/lib/type-helpers';
import { filterNullAndUndefined, makeProtoEnumConverters } from '@temporalio/common/lib/internal-workflow';
import { temporal } from '@temporalio/proto';
import { BaseClient, BaseClientOptions, defaultBaseClientOptions, LoadedWithDefaults } from './base-client';
import { WorkflowService } from './types';
import { BuildIdOperation, versionSetsFromProto, WorkerBuildIdVersionSets } from './build-id-types';
import { isGrpcServiceError, ServiceError } from './errors';
import { rethrowKnownErrorTypes } from './helpers';

type IUpdateWorkerBuildIdCompatibilityRequest =
  temporal.api.workflowservice.v1.IUpdateWorkerBuildIdCompatibilityRequest;
type GetWorkerTaskReachabilityResponse = temporal.api.workflowservice.v1.GetWorkerTaskReachabilityResponse;

/**
 * @experimental The Worker Versioning API is still being designed. Major changes are expected.
 */
export type TaskQueueClientOptions = BaseClientOptions;

/**
 * @experimental The Worker Versioning API is still being designed. Major changes are expected.
 */
export type LoadedTaskQueueClientOptions = LoadedWithDefaults<TaskQueueClientOptions>;

/**
 * A stand-in for a Build Id for unversioned Workers
 * @experimental The Worker Versioning API is still being designed. Major changes are expected.
 */
export const UnversionedBuildId = Symbol.for('__temporal_unversionedBuildId');
export type UnversionedBuildIdType = typeof UnversionedBuildId;

/**
 * Client for starting Workflow executions and creating Workflow handles
 *
 * @experimental The Worker Versioning API is still being designed. Major changes are expected.
 */
export class TaskQueueClient extends BaseClient {
  public readonly options: LoadedTaskQueueClientOptions;

  constructor(options?: TaskQueueClientOptions) {
    super(options);
    this.options = {
      ...defaultBaseClientOptions(),
      ...filterNullAndUndefined(options ?? {}),
      loadedDataConverter: this.dataConverter,
    };
  }

  /**
   * Raw gRPC access to the Temporal service.
   *
   * **NOTE**: The namespace provided in {@link options} is **not** automatically set on requests
   * using this service attribute.
   */
  get workflowService(): WorkflowService {
    return this.connection.workflowService;
  }

  /**
   * Used to add new Build Ids or otherwise update the relative compatibility of Build Ids as
   * defined on a specific task queue for the Worker Versioning feature. For more on this feature,
   * see https://docs.temporal.io/workers#worker-versioning
   *
   * @param taskQueue The task queue to make changes to.
   * @param operation The operation to be performed.
   */
  public async updateBuildIdCompatibility(taskQueue: string, operation: BuildIdOperation): Promise<void> {
    const request: IUpdateWorkerBuildIdCompatibilityRequest = {
      namespace: this.options.namespace,
      taskQueue,
    };
    switch (operation.operation) {
      case 'addNewIdInNewDefaultSet':
        request.addNewBuildIdInNewDefaultSet = operation.buildId;
        break;
      case 'addNewCompatibleVersion':
        request.addNewCompatibleBuildId = {
          newBuildId: operation.buildId,
          existingCompatibleBuildId: operation.existingCompatibleBuildId,
        };
        break;
      case 'promoteSetByBuildId':
        request.promoteSetByBuildId = operation.buildId;
        break;
      case 'promoteBuildIdWithinSet':
        request.promoteBuildIdWithinSet = operation.buildId;
        break;
      case 'mergeSets':
        request.mergeSets = {
          primarySetBuildId: operation.primaryBuildId,
          secondarySetBuildId: operation.secondaryBuildId,
        };
        break;
      default:
        assertNever('Unknown build id update operation', operation);
    }
    try {
      await this.workflowService.updateWorkerBuildIdCompatibility(request);
    } catch (e) {
      this.rethrowGrpcError(e, 'Unexpected error updating Build Id compatibility');
    }
  }

  /**
   * Fetch the sets of compatible Build Ids for a given task queue.
   *
   * @param taskQueue The task queue to fetch the compatibility information for.
   * @returns The sets of compatible Build Ids for the given task queue, or undefined if the queue
   *          has no Build Ids defined on it.
   */
  public async getBuildIdCompatability(taskQueue: string): Promise<WorkerBuildIdVersionSets | undefined> {
    let resp;
    try {
      resp = await this.workflowService.getWorkerBuildIdCompatibility({
        taskQueue,
        namespace: this.options.namespace,
      });
    } catch (e) {
      this.rethrowGrpcError(e, 'Unexpected error fetching Build Id compatibility');
    }
    if (resp.majorVersionSets == null || resp.majorVersionSets.length === 0) {
      return undefined;
    }
    return versionSetsFromProto(resp);
  }

  /**
   * Fetches task reachability to determine whether a worker may be retired. The request may specify
   * task queues to query for or let the server fetch all task queues mapped to the given build IDs.
   *
   * When requesting a large number of task queues or all task queues associated with the given
   * build ids in a namespace, all task queues will be listed in the response but some of them may
   * not contain reachability information due to a server enforced limit. When reaching the limit,
   * task queues that reachability information could not be retrieved for will be marked with a
   * `NotFetched` entry in {@link BuildIdReachability.taskQueueReachability}. The caller may issue
   * another call to get the reachability for those task queues.
   */
  public async getReachability(options: ReachabilityOptions): Promise<ReachabilityResponse> {
    let resp;
    const buildIds = options.buildIds?.map((bid) => {
      if (bid === UnversionedBuildId) {
        return '';
      }
      return bid;
    });
    try {
      resp = await this.workflowService.getWorkerTaskReachability({
        namespace: this.options.namespace,
        taskQueues: options.taskQueues,
        buildIds,
        reachability: encodeTaskReachability(options.reachability),
      });
    } catch (e) {
      this.rethrowGrpcError(e, 'Unexpected error fetching Build Id reachability');
    }
    return reachabilityResponseFromProto(resp);
  }

  protected rethrowGrpcError(err: unknown, fallbackMessage: string): never {
    if (isGrpcServiceError(err)) {
      rethrowKnownErrorTypes(err);
      if (err.code === status.NOT_FOUND) {
        throw new BuildIdNotFoundError(err.details ?? 'Build Id not found');
      }
      throw new ServiceError(fallbackMessage, { cause: err });
    }
    throw new ServiceError('Unexpected error while making gRPC request');
  }
}

/**
 * Options for {@link TaskQueueClient.getReachability}
 */
export type ReachabilityOptions = RequireAtLeastOne<BaseReachabilityOptions, 'buildIds' | 'taskQueues'>;

export const ReachabilityType = {
  /** The Build Id might be used by new workflows. */
  NEW_WORKFLOWS: 'NEW_WORKFLOWS',

  /** The Build Id might be used by open workflows and/or closed workflows. */
  EXISTING_WORKFLOWS: 'EXISTING_WORKFLOWS',

  /** The Build Id might be used by open workflows. */
  OPEN_WORKFLOWS: 'OPEN_WORKFLOWS',

  /** The Build Id might be used by closed workflows. */
  CLOSED_WORKFLOWS: 'CLOSED_WORKFLOWS',
} as const;

/**
 * There are different types of reachability:
 *   - `NEW_WORKFLOWS`: The Build Id might be used by new workflows
 *   - `EXISTING_WORKFLOWS` The Build Id might be used by open workflows and/or closed workflows.
 *   - `OPEN_WORKFLOWS` The Build Id might be used by open workflows
 *   - `CLOSED_WORKFLOWS` The Build Id might be used by closed workflows
 */
export type ReachabilityType = (typeof ReachabilityType)[keyof typeof ReachabilityType];

export const [encodeTaskReachability, decodeTaskReachability] = makeProtoEnumConverters<
  temporal.api.enums.v1.TaskReachability,
  typeof temporal.api.enums.v1.TaskReachability,
  keyof typeof temporal.api.enums.v1.TaskReachability,
  typeof ReachabilityType,
  'TASK_REACHABILITY_'
>(
  {
    [ReachabilityType.NEW_WORKFLOWS]: 1,
    [ReachabilityType.EXISTING_WORKFLOWS]: 2,
    [ReachabilityType.OPEN_WORKFLOWS]: 3,
    [ReachabilityType.CLOSED_WORKFLOWS]: 4,
    UNSPECIFIED: 0,
  } as const,
  'TASK_REACHABILITY_'
);

/**
 * See {@link ReachabilityOptions}
 */
export interface BaseReachabilityOptions {
  /**
   * A list of build ids to query the reachability of. Currently, at least one Build Id must be
   * specified, but this restriction may be lifted in the future.
   */
  buildIds: (string | UnversionedBuildIdType)[];
  /**
   * A list of task queues with Build Ids defined on them that the request is
   * concerned with.
   */
  taskQueues?: string[];
  /** The kind of reachability this request is concerned with. */
  reachability?: ReachabilityType;
}

export interface ReachabilityResponse {
  /** Maps Build Ids to their reachability information. */
  buildIdReachability: Record<string | UnversionedBuildIdType, BuildIdReachability>;
}

export type ReachabilityTypeResponse = ReachabilityType | 'NOT_FETCHED';

export interface BuildIdReachability {
  /**
   *  Maps Task Queue names to how the Build Id may be reachable from them. If they are not
   *  reachable, the map value will be an empty array.
   */
  taskQueueReachability: Record<string, ReachabilityTypeResponse[]>;
}

export function reachabilityResponseFromProto(resp: GetWorkerTaskReachabilityResponse): ReachabilityResponse {
  return {
    buildIdReachability: Object.fromEntries(
      resp.buildIdReachability.map((bir) => {
        const taskQueueReachability: Record<string, ReachabilityTypeResponse[]> = {};
        if (bir.taskQueueReachability != null) {
          for (const tqr of bir.taskQueueReachability) {
            if (tqr.taskQueue == null) {
              continue;
            }
            if (tqr.reachability == null) {
              taskQueueReachability[tqr.taskQueue] = [];
              continue;
            }
            taskQueueReachability[tqr.taskQueue] = tqr.reachability.map(
              (x) => decodeTaskReachability(x) ?? 'NOT_FETCHED'
            );
          }
        }
        let bid: string | UnversionedBuildIdType;
        if (bir.buildId) {
          bid = bir.buildId;
        } else {
          bid = UnversionedBuildId;
        }
        return [bid, { taskQueueReachability }];
      })
    ) as Record<string | UnversionedBuildIdType, BuildIdReachability>,
  };
}

/**
 * Thrown when one or more Build Ids are not found while using the {@link TaskQueueClient}.
 *
 * It could be because:
 * - Id passed is incorrect
 * - Build Id has been scavenged by the server.
 *
 * @experimental The Worker Versioning API is still being designed. Major changes are expected.
 */
@SymbolBasedInstanceOfError('BuildIdNotFoundError')
export class BuildIdNotFoundError extends Error {}
