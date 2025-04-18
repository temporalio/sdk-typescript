import 'abort-controller/polyfill'; // eslint-disable-line import/no-unassigned-import
import {
  Client,
  ClientOptions,
  WorkflowClient,
  WorkflowClientOptions,
  WorkflowResultOptions,
} from '@temporalio/client';
import { Connection, TestService } from './connection';

// Config ///////////////////////////////////////////////////////////////////////////////////////////

export interface TimeSkippingWorkflowClientOptions extends WorkflowClientOptions {
  connection: Connection;
  enableTimeSkipping: boolean;
}

export interface TestEnvClientOptions extends ClientOptions {
  connection: Connection;
  enableTimeSkipping: boolean;
}

/**
 * Subset of the "normal" client options that are used to create a client for the test environment.
 */
export type ClientOptionsForTestEnv = Omit<ClientOptions, 'namespace' | 'connection'>;

// Implementation //////////////////////////////////////////////////////////////////////////////////

/**
 * A client with the exact same API as the "normal" client with 1 exception,
 * When this client waits on a Workflow's result, it will enable time skipping
 * in the test server.
 */
export class TimeSkippingWorkflowClient extends WorkflowClient {
  protected readonly testService: TestService;
  protected readonly enableTimeSkipping: boolean;

  constructor(options: TimeSkippingWorkflowClientOptions) {
    super(options);
    this.enableTimeSkipping = options.enableTimeSkipping;
    this.testService = options.connection.testService;
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
    if (this.enableTimeSkipping) {
      await this.testService.unlockTimeSkipping({});
      try {
        return await super.result(workflowId, runId, opts);
      } finally {
        await this.testService.lockTimeSkipping({});
      }
    } else {
      return await super.result(workflowId, runId, opts);
    }
  }
}

/**
 * A client with the exact same API as the "normal" client with one exception:
 * when `TestEnvClient.workflow` (an instance of {@link TimeSkippingWorkflowClient}) waits on a Workflow's result, it will enable time skipping
 * in the Test Server.
 */
export class TestEnvClient extends Client {
  constructor(options: TestEnvClientOptions) {
    super(options);

    // Recreate the client (this isn't optimal but it's better than adding public methods just for testing).
    // NOTE: we cast to "any" to work around `workflow` being a readonly attribute.
    (this as any).workflow = new TimeSkippingWorkflowClient({
      ...this.workflow.options,
      connection: options.connection,
      enableTimeSkipping: options.enableTimeSkipping,
    });
  }
}
