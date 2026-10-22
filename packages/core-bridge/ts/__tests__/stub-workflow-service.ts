import path from 'node:path';
import { promisify } from 'node:util';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const protosDir = path.resolve(__dirname, '../../sdk-core/crates/protos/protos/api_upstream');
const workflowServiceDefinition = protoLoader.loadSync(
  path.join(protosDir, 'temporal/api/workflowservice/v1/service.proto'),
  { includeDirs: [protosDir] }
)['temporal.api.workflowservice.v1.WorkflowService'] as grpc.ServiceDefinition;

export interface StubWorkflowService {
  /** URL for a native client's `targetUrl`. */
  readonly targetUrl: string;
  close(): void;
}

/**
 * Start a stand-in for the Temporal server's WorkflowService that answers only the calls these tests make.
 *
 * Polls never complete, like a long poll with no work, so they only end when the Worker shuts down. Any other call
 * fails with UNIMPLEMENTED.
 */
export async function startStubWorkflowService(): Promise<StubWorkflowService> {
  const server = new grpc.Server();
  server.addService(workflowServiceDefinition, {
    getSystemInfo(_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) {
      callback(null, {});
    },
    describeNamespace(_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) {
      callback(null, { namespaceInfo: { name: 'default' } });
    },
    pollWorkflowTaskQueue() {
      // Never respond.
    },
    pollActivityTaskQueue() {
      // Never respond.
    },
    shutdownWorker(_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) {
      callback(null, {});
    },
  });
  const port = await promisify(server.bindAsync.bind(server))('127.0.0.1:0', grpc.ServerCredentials.createInsecure());
  return {
    targetUrl: `http://127.0.0.1:${port}`,
    close: () => server.forceShutdown(),
  };
}
