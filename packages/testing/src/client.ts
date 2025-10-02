import 'abort-controller/polyfill'; // eslint-disable-line import/no-unassigned-import
import {
  Client,
  ClientOptions,
  Connection,
  TestService,
  WorkflowClient,
  WorkflowClientOptions,
  WorkflowResultOptions,
} from '@temporalio/client';

/**
 * Subset of the "normal" client options that are used to create a client for the test environment.
 */
export type ClientOptionsForTestEnv = Omit<ClientOptions, 'namespace' | 'connection'>;

/**
 * A client with the exact same API as the "normal" client with one exception:
 * when `TestEnvClient.workflow` (an instance of {@link TimeSkippingWorkflowClient})
 * waits on a Workflow's result, it will enable time skipping in the Test Server.
 */
export class TimeSkippingClient extends Client {
  constructor(options: ClientOptions) {
    super(options);

    // Recreate the client (this isn't optimal but it's better than adding public methods just for testing).
    // NOTE: we cast to "any" to work around `workflow` being a readonly attribute.
    (this as any).workflow = new TimeSkippingWorkflowClient({
      ...this.workflow.options,
      connection: options.connection,
    });
  }
}

/**
 * A client with the exact same API as the "normal" client with one exception: when this client
 * waits on a Workflow's result, it will enable time skipping in the Test Server.
 */
export class TimeSkippingWorkflowClient extends WorkflowClient {
  protected readonly testService: TestService;

  constructor(options: WorkflowClientOptions) {
    super(options);
    const testService = (options.connection as Connection).testService;
    if (!testService) {
      throw new TypeError('TestService must be present when creating a TimeSkippingWorkflowClient');
    }
    this.testService = testService;
  }

  /**
   * Gets the result of a Workflow execution.
   *
   * @see {@link WorkflowClient.result}
   */
  override async result<T>(
    workflowId: string,
    runId?: string | undefined,
    opts?: WorkflowResultOptions | undefined
  ): Promise<T> {
    await this.testService.unlockTimeSkipping({});
    try {
      return await super.result(workflowId, runId, opts);
    } finally {
      await this.testService.lockTimeSkipping({});
    }
  }
}
