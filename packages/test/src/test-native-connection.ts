import util from 'node:util';
import path from 'node:path';
import test from 'ava';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { IllegalStateError, NativeConnection, TransportError } from '@temporalio/worker';
import { temporal } from '@temporalio/proto';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';

const workflowServicePackageDefinition = protoLoader.loadSync(
  path.resolve(
    __dirname,
    '../../core-bridge/sdk-core/sdk-core-protos/protos/api_upstream/temporal/api/workflowservice/v1/service.proto'
  ),
  { includeDirs: [path.resolve(__dirname, '../../core-bridge/sdk-core/sdk-core-protos/protos/api_upstream')] }
);
const workflowServiceProtoDescriptor = grpc.loadPackageDefinition(workflowServicePackageDefinition) as any;

async function bindLocalhostIpv6(server: grpc.Server): Promise<number> {
  return await util.promisify(server.bindAsync.bind(server))('[::1]:0', grpc.ServerCredentials.createInsecure());
}

test('NativeConnection.connect() throws meaningful error when passed invalid address', async (t) => {
  await t.throwsAsync(NativeConnection.connect({ address: ':invalid' }), {
    instanceOf: TypeError,
    message: /Invalid address for Temporal gRPC endpoint.*/,
  });
});

test('NativeConnection.connect() throws meaningful error when passed invalid clientCertPair', async (t) => {
  await t.throwsAsync(NativeConnection.connect({ tls: { clientCertPair: {} as any } }), {
    instanceOf: TypeError,
    message: 'Invalid or missing serverOptions.tls.clientCertPair.crt',
  });
});

if (RUN_INTEGRATION_TESTS) {
  test('NativeConnection errors have detail', async (t) => {
    await t.throwsAsync(() => NativeConnection.connect({ address: '127.0.0.1:1' }), {
      instanceOf: TransportError,
      message: /.*Connection[ ]?refused.*/i,
    });
  });

  test('NativeConnection.close() throws when called a second time', async (t) => {
    const conn = await NativeConnection.connect();
    await conn.close();
    await t.throwsAsync(() => conn.close(), {
      instanceOf: IllegalStateError,
      message: 'Client already closed',
    });
  });

  test('NativeConnection.close() throws if being used by a Worker and succeeds if it has been shutdown', async (t) => {
    const connection = await NativeConnection.connect();
    const worker = await Worker.create({
      connection,
      taskQueue: 'default',
      activities: {
        async noop() {
          // empty placeholder
        },
      },
    });
    try {
      await t.throwsAsync(() => connection.close(), {
        instanceOf: IllegalStateError,
        message: 'Cannot close connection while Workers hold a reference to it',
      });
    } finally {
      const p = worker.run();
      worker.shutdown();
      await p;
      await connection.close();
    }
  });
}

test('NativeConnection can connect using "[ipv6]:port" address', async (t) => {
  let gotRequest = false;
  const server = new grpc.Server();
  server.addService(workflowServiceProtoDescriptor.temporal.api.workflowservice.v1.WorkflowService.service, {
    getSystemInfo(
      call: grpc.ServerUnaryCall<
        temporal.api.workflowservice.v1.IGetSystemInfoRequest,
        temporal.api.workflowservice.v1.IGetSystemInfoResponse
      >,
      callback: grpc.sendUnaryData<temporal.api.workflowservice.v1.IGetSystemInfoResponse>
    ) {
      gotRequest = true;
      callback(null, {});
    },
  });
  const port = await bindLocalhostIpv6(server);
  const connection = await NativeConnection.connect({
    address: `[::1]:${port}`,
  });
  t.true(gotRequest);
  await connection.close();
  await server.forceShutdown();
});
