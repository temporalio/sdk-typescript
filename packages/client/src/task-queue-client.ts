import { BaseClient, BaseClientOptions, defaultBaseClientOptions, LoadedWithDefaults } from './base-client';
import { WorkflowService } from './types';
import { filterNullAndUndefined } from '@temporalio/common/lib/internal-non-workflow';
import { BuildIdOperation, versionSetsFromProto, WorkerBuildIdVersionSets } from './build-id-types';
import { assertNever } from '@temporalio/common/lib/type-helpers';
import { temporal } from '@temporalio/proto';
import IUpdateWorkerBuildIdCompatibilityRequest = temporal.api.workflowservice.v1.IUpdateWorkerBuildIdCompatibilityRequest;

/**
 * @experimental
 */
export interface TaskQueueClientOptions extends BaseClientOptions {}

/**
 * @experimental
 */
export type LoadedTaskQueueClientOptions = LoadedWithDefaults<TaskQueueClientOptions>;

/**
 * Client for starting Workflow executions and creating Workflow handles
 *
 * @experimental
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
   * Raw gRPC access to the Temporal service. Schedule-related methods are included in {@link WorkflowService}.
   *
   * **NOTE**: The namespace provided in {@link options} is **not** automatically set on requests made to the service.
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
  public async updateWorkerBuildIdCompatibility(taskQueue: string, operation: BuildIdOperation): Promise<void> {
    const request: IUpdateWorkerBuildIdCompatibilityRequest = {
      namespace: this.options.namespace,
      taskQueue,
    };
    switch (operation.operation) {
      case 'newIdInNewDefaultSet':
        request.addNewBuildIdInNewDefaultSet = operation.buildId;
        break;
      case 'newCompatibleVersion':
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
        assertNever(operation);
    }
    await this.workflowService.updateWorkerBuildIdCompatibility(request);
  }

  /**
   * Fetch the sets of compatible Build Ids for a given task queue.
   *
   * @param taskQueue The task queue to fetch the compatibility information for.
   * @returns The sets of compatible Build Ids for the given task queue, or undefined if the queue
   *          has no Build Ids defined on it.
   */
  public async getWorkerBuildIdCompatability(taskQueue: string): Promise<WorkerBuildIdVersionSets | undefined> {
    const resp = await this.workflowService.getWorkerBuildIdCompatibility({
      taskQueue,
      namespace: this.options.namespace,
    });
    if (resp.majorVersionSets == null || resp.majorVersionSets.length === 0) {
      return undefined;
    }
    return versionSetsFromProto(resp);
  }
}
