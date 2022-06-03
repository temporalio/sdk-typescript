import test from 'ava';
import util from 'util';
import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Connection } from '@temporalio/client';
import pkg from '@temporalio/client/lib/pkg';
import { temporal } from '@temporalio/proto';

test('withMetadata / withDeadline set the CallContext for RPC call', async (t) => {
  const packageDefinition = protoLoader.loadSync(
    path.resolve(
      __dirname,
      '../../core-bridge/sdk-core/protos/api_upstream/temporal/api/workflowservice/v1/service.proto'
    ),
    { includeDirs: [path.resolve(__dirname, '../../core-bridge/sdk-core/protos/api_upstream')] }
  );
  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;

  const server = new grpc.Server();
  let gotTestHeaders = false;
  let gotDeadline = false;
  const deadline = Date.now() + 10000;

  server.addService(protoDescriptor.temporal.api.workflowservice.v1.WorkflowService.service, {
    registerNamespace(
      call: grpc.ServerUnaryCall<
        temporal.api.workflowservice.v1.IRegisterNamespaceRequest,
        temporal.api.workflowservice.v1.IRegisterNamespaceResponse
      >,
      callback: grpc.sendUnaryData<temporal.api.workflowservice.v1.IRegisterNamespaceResponse>
    ) {
      const [testValue] = call.metadata.get('test');
      const [otherValue] = call.metadata.get('otherKey');
      const [staticValue] = call.metadata.get('staticKey');
      const [clientName] = call.metadata.get('client-name');
      const [clientVersion] = call.metadata.get('client-version');
      if (
        testValue === 'true' &&
        otherValue === 'set' &&
        staticValue === 'set' &&
        clientName === 'temporal-typescript' &&
        clientVersion === pkg.version
      ) {
        gotTestHeaders = true;
      }
      const receivedDeadline = call.getDeadline();
      // For some reason the deadline the server gets is slightly different from the one we send in the client
      if (typeof receivedDeadline === 'number' && receivedDeadline >= deadline && receivedDeadline - deadline < 1000) {
        gotDeadline = true;
      }
      callback(null, {});
    },
  });
  const port = await util.promisify(server.bindAsync.bind(server))(
    '127.0.0.1:0',
    grpc.ServerCredentials.createInsecure()
  );
  server.start();
  const conn = await Connection.connect({ address: `127.0.0.1:${port}`, metadata: { staticKey: 'set' } });
  await conn.withMetadata({ test: 'true' }, () =>
    conn.withMetadata({ otherKey: 'set' }, () =>
      conn.withDeadline(deadline, () => conn.workflowService.registerNamespace({}))
    )
  );
  t.true(gotTestHeaders);
  t.true(gotDeadline);
});
