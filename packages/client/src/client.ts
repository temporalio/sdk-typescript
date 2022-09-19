import { DataConverter, LoadedDataConverter } from '@temporalio/common';
import { filterNullAndUndefined, loadDataConverter } from '@temporalio/internal-non-workflow-common';
import { Replace } from '@temporalio/internal-workflow-common';
import { temporal } from '@temporalio/proto';
import os from 'os';
import { AsyncCompletionClient } from './async-completion-client';
import { Connection } from './connection';
import { ClientInterceptors } from './interceptors';
import { ConnectionLike, Metadata, WorkflowService } from './types';
import { WorkflowClient } from './workflow-client';

export interface ClientOptions {
  /**
   * {@link DataConverter} to use for serializing and deserializing payloads
   */
  dataConverter?: DataConverter;

  /**
   * Used to override and extend default Connection functionality
   *
   * Useful for injecting auth headers and tracing Workflow executions
   */
  interceptors?: ClientInterceptors;

  /**
   * Identity to report to the server
   *
   * @default `${process.pid}@${os.hostname()}`
   */
  identity?: string;

  /**
   * Connection to use to communicate with the server.
   *
   * By default `WorkflowClient` connects to localhost.
   *
   * Connections are expensive to construct and should be reused.
   */
  connection?: ConnectionLike;

  /**
   * Server namespace
   *
   * @default default
   */
  namespace?: string;

  workflow?: {
    /**
     * Should a query be rejected by closed and failed workflows
     *
     * @default QUERY_REJECT_CONDITION_UNSPECIFIED which means that closed and failed workflows are still queryable
     */
    queryRejectCondition?: temporal.api.enums.v1.QueryRejectCondition;
  };
}

export type ClientOptionsWithDefaults = Replace<
  Required<ClientOptions>,
  {
    connection?: ConnectionLike;
  }
>;

export type LoadedClientOptions = ClientOptionsWithDefaults & {
  loadedDataConverter: LoadedDataConverter;
};

export function defaultClientOptions(): ClientOptionsWithDefaults {
  return {
    dataConverter: {},
    identity: `${process.pid}@${os.hostname()}`,
    interceptors: {},
    namespace: 'default',
    workflow: {
      queryRejectCondition: temporal.api.enums.v1.QueryRejectCondition.QUERY_REJECT_CONDITION_UNSPECIFIED,
    },
  };
}

/**
 * High level SDK client.
 *
 *
 */
export class Client {
  /**
   * Underlying gRPC connection to the Temporal service
   */
  public readonly connection: ConnectionLike;
  public readonly options: LoadedClientOptions;
  /**
   * Workflow sub-client - use to start and interact with Workflows
   */
  public readonly workflow: WorkflowClient;
  /**
   * (Async) Activity completion sub-client - use to manually manage Activities
   */
  public readonly activity: AsyncCompletionClient;

  constructor(options?: ClientOptions) {
    this.connection = options?.connection ?? Connection.lazy();
    this.options = {
      ...defaultClientOptions(),
      ...filterNullAndUndefined(options ?? {}),
      loadedDataConverter: loadDataConverter(options?.dataConverter),
    };

    const { workflow, loadedDataConverter, interceptors, ...base } = this.options;

    this.workflow = new WorkflowClient({
      ...base,
      ...workflow,
      connection: this.connection,
      dataConverter: loadedDataConverter,
      interceptors: interceptors.workflow,
    });

    this.activity = new AsyncCompletionClient({
      ...base,
      connection: this.connection,
      dataConverter: loadedDataConverter,
    });
  }

  /**
   * Raw gRPC access to the Temporal service.
   *
   * **NOTE**: The namespace provided in {@link options} is **not** automatically set on requests made to the service.
   */
  get workflowService(): WorkflowService {
    return this.connection.workflowService;
  }

  /**
   * Set the deadline for any service requests executed in `fn`'s scope.
   */
  async withDeadline<R>(deadline: number | Date, fn: () => Promise<R>): Promise<R> {
    return await this.connection.withDeadline(deadline, fn);
  }

  /**
   * Set metadata for any service requests executed in `fn`'s scope.
   *
   * @returns returned value of `fn`
   *
   * @see {@link Connection.withMetadata}
   */
  async withMetadata<R>(metadata: Metadata, fn: () => Promise<R>): Promise<R> {
    return await this.connection.withMetadata(metadata, fn);
  }
}
