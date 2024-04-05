import { Connection as BaseConnection, ConnectionOptions } from '@temporalio/client';
import { ConnectionCtorOptions as BaseConnectionCtorOptions } from '@temporalio/client/lib/connection';
import { temporal } from '@temporalio/proto';

export type TestService = temporal.api.testservice.v1.TestService;
export const { TestService } = temporal.api.testservice.v1;

interface ConnectionCtorOptions extends BaseConnectionCtorOptions {
  testService: TestService;
}

/**
 * A Connection class that can be used to interact with both the test server's TestService and WorkflowService
 */
export class Connection extends BaseConnection {
  public readonly testService: TestService;

  protected static createCtorOptions(options?: ConnectionOptions): ConnectionCtorOptions {
    const ctorOptions = BaseConnection.createCtorOptions(options);
    const rpcImpl = this.generateRPCImplementation({
      serviceName: 'temporal.api.testservice.v1.TestService',
      client: ctorOptions.client,
      callContextStorage: ctorOptions.callContextStorage,
      interceptors: ctorOptions.options.interceptors,
      staticMetadata: ctorOptions.options.metadata,
      apiKeyFnRef: {},
    });
    const testService = TestService.create(rpcImpl, false, false);
    return { ...ctorOptions, testService };
  }

  static lazy(options?: ConnectionOptions): Connection {
    const ctorOptions = this.createCtorOptions(options);
    return new this(ctorOptions);
  }

  static async connect(options?: ConnectionOptions): Promise<Connection> {
    const ret = this.lazy(options);
    await ret.ensureConnected();
    return ret;
  }

  protected constructor(options: ConnectionCtorOptions) {
    super(options);
    this.testService = options.testService;
  }
}
