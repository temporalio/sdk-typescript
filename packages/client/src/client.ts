import { filterNullAndUndefined } from '@temporalio/common/lib/internal-non-workflow';
import { temporal } from '@temporalio/proto';
import { AsyncCompletionClient } from './async-completion-client';
import { BaseClient, BaseClientOptions, defaultBaseClientOptions, LoadedWithDefaults } from './base-client';
import { ClientInterceptors } from './interceptors';
import { ScheduleClient } from './schedule-client';
import { WorkflowService } from './types';
import { WorkflowClient } from './workflow-client';

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
     * @default QUERY_REJECT_CONDITION_UNSPECIFIED which means that closed and failed workflows are still queryable
     */
    queryRejectCondition?: temporal.api.enums.v1.QueryRejectCondition;
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
   *
   * @experimental
   */
  public readonly schedule: ScheduleClient;

  constructor(options?: ClientOptions) {
    super(options);

    const { interceptors, workflow, ...commonOptions } = options ?? {};

    this.workflow = new WorkflowClient({
      ...commonOptions,
      ...(workflow ?? {}),
      connection: this.connection,
      dataConverter: this.dataConverter,
      interceptors: interceptors?.workflow,
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
