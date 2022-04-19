import * as grpc from '@grpc/grpc-js';
import { Connection as BaseConnection, ConnectionOptions } from '@temporalio/client';
import { temporal } from '../generated-protos';

export type TestService = temporal.api.testservice.v1.TestService;
export const { TestService } = temporal.api.testservice.v1;

/**
 * A Connection class that can be used to interact with both the test server's TestService and WorkflowService
 */
export class Connection extends BaseConnection {
  public static readonly TestServiceClient = grpc.makeGenericClientConstructor({}, 'TestService', {});
  public readonly testService: TestService;

  constructor(options?: ConnectionOptions) {
    super(options);

    const rpcImpl = this.generateRPCImplementation('temporal.api.testservice.v1.TestService');
    this.testService = new TestService(rpcImpl, false, false);
  }
}
