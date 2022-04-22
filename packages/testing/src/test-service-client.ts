import * as grpc from '@grpc/grpc-js';
import { Connection as BaseConnection, ConnectionOptions } from '@temporalio/client';
import { ConnectionCtorOptions as BaseConnectionCtorOptions } from '@temporalio/client/lib/connection';
import { temporal } from '../generated-protos';

export type TestService = temporal.api.testservice.v1.TestService;
export const { TestService } = temporal.api.testservice.v1;

interface ConnectionCtorOptions extends BaseConnectionCtorOptions {
  testService: TestService;
}

/**
 * A Connection class that can be used to interact with both the test server's TestService and WorkflowService
 */
export class Connection extends BaseConnection {
  public static readonly TestServiceClient = grpc.makeGenericClientConstructor({}, 'TestService', {});
  public readonly testService: TestService;

  static async create(options?: ConnectionOptions): Promise<Connection> {
    const ctorOptions = await this.createCtorOptions(options);
    const rpcImpl = this.generateRPCImplementation({
      serviceName: 'temporal.api.testservice.v1.TestService',
      client: ctorOptions.client,
      callContextStorage: ctorOptions.callContextStorage,
      interceptors: ctorOptions.options.interceptors,
    });
    const testService = TestService.create(rpcImpl, false, false);
    return new this({ ...ctorOptions, testService });
  }

  protected constructor(options: ConnectionCtorOptions) {
    super(options);
    this.testService = options.testService;
  }
}
