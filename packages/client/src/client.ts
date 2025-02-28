import { filterNullAndUndefined } from '@temporalio/common/lib/internal-workflow';
import { AsyncCompletionClient } from './async-completion-client';
import { BaseClient, BaseClientOptions, defaultBaseClientOptions, LoadedWithDefaults } from './base-client';
import { ClientInterceptors } from './interceptors';
import { ScheduleClient } from './schedule-client';
import { QueryRejectCondition, WorkflowService } from './types';
import { WorkflowClient } from './workflow-client';
import { TaskQueueClient } from './task-queue-client';

export interface ClientOptions extends BaseClientOptions {
  /**
   * Used to override and extend default Connection functionality
   *
   * Useful for injecting auth headers and tracing Workflow executions
   */
  interceptors?: ClientInterceptors;

  workflow?: {
    /**
     * Should a query be rejected by closed and failed workflows
     *
     * @default `undefined`, which means that closed and failed workflows are still queryable
     */
    queryRejectCondition?: QueryRejectCondition;
  };
}

export type LoadedClientOptions = LoadedWithDefaults<ClientOptions>;

/**
 * High level SDK client.
 */
export class Client extends BaseClient {
  public readonly options: LoadedClientOptions;
  /**
   * Workflow sub-client - use to start and interact with Workflows
   */
  public readonly workflow: WorkflowClient;
  /**
   * (Async) Activity completion sub-client - use to manually manage Activities
   */
  public readonly activity: AsyncCompletionClient;
  /**
   * Schedule sub-client - use to start and interact with Schedules
   */
  public readonly schedule: ScheduleClient;
  /**
   * Task Queue sub-client - use to perform operations on Task Queues
   *
   * @experimental The Worker Versioning API is still being designed. Major changes are expected.
   */
  public readonly taskQueue: TaskQueueClient;

  constructor(options?: ClientOptions) {
    super(options);

    const { interceptors, workflow, ...commonOptions } = options ?? {};

    this.workflow = new WorkflowClient({
      ...commonOptions,
      ...(workflow ?? {}),
      connection: this.connection,
      dataConverter: this.dataConverter,
      interceptors: interceptors?.workflow,
      queryRejectCondition: workflow?.queryRejectCondition,
    });

    this.activity = new AsyncCompletionClient({
      ...commonOptions,
      connection: this.connection,
      dataConverter: this.dataConverter,
    });

    this.schedule = new ScheduleClient({
      ...commonOptions,
      connection: this.connection,
      dataConverter: this.dataConverter,
      interceptors: interceptors?.schedule,
    });

    this.taskQueue = new TaskQueueClient({
      ...commonOptions,
      connection: this.connection,
      dataConverter: this.dataConverter,
    });

    this.options = {
      ...defaultBaseClientOptions(),
      ...filterNullAndUndefined(commonOptions),
      loadedDataConverter: this.dataConverter,
      interceptors: {
        workflow: this.workflow.options.interceptors,
        schedule: this.schedule.options.interceptors,
      },
      workflow: {
        queryRejectCondition: this.workflow.options.queryRejectCondition,
      },
    };
  }

  /**
   * Raw gRPC access to the Temporal service.
   *
   * **NOTE**: The namespace provided in {@link options} is **not** automatically set on requests made via this service
   * object.
   */
  get workflowService(): WorkflowService {
    return this.connection.workflowService;
  }
}
