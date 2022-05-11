import test from 'ava';
import { Subject, firstValueFrom } from 'rxjs';
import util from 'util';
import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { NativeConnection, Worker } from '@temporalio/worker';
import { temporal } from '@temporalio/proto';

test('NativeConnection passes headers provided in options', async (t) => {
  const packageDefinition = protoLoader.loadSync(
    path.resolve(
      __dirname,
      '../../core-bridge/sdk-core/protos/api_upstream/temporal/api/workflowservice/v1/service.proto'
    ),
    { includeDirs: [path.resolve(__dirname, '../../core-bridge/sdk-core/protos/api_upstream')] }
  );
  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;

  const server = new grpc.Server();
  let gotInitialHeader = false;
  const updateSubject = new Subject<void>();

  // Create a mock server to verify headers are actually sent
  server.addService(protoDescriptor.temporal.api.workflowservice.v1.WorkflowService.service, {
    // called on NativeConnection.create()
    getSystemInfo(
      call: grpc.ServerUnaryCall<
        temporal.api.workflowservice.v1.IGetSystemInfoRequest,
        temporal.api.workflowservice.v1.IGetSystemInfoResponse
      >,
      callback: grpc.sendUnaryData<temporal.api.workflowservice.v1.IGetSystemInfoResponse>
    ) {
      const [value] = call.metadata.get('initial');
      if (value === 'true') {
        gotInitialHeader = true;
      }
      callback(null, {});
    },
    // called when worker starts polling for tasks
    pollActivityTaskQueue(
      call: grpc.ServerUnaryCall<
        temporal.api.workflowservice.v1.IPollActivityTaskQueueRequest,
        temporal.api.workflowservice.v1.PollActivityTaskQueueResponse
      >,
      callback: grpc.sendUnaryData<temporal.api.workflowservice.v1.IPollActivityTaskQueueResponse>
    ) {
      const [value] = call.metadata.get('update');
      if (value === 'true') {
        updateSubject.next();
      }
      callback(new Error());
    },
  });
  const port = await util.promisify(server.bindAsync.bind(server))(
    '127.0.0.1:0',
    grpc.ServerCredentials.createInsecure()
  );
  server.start();

  const connection = await NativeConnection.create({
    address: `127.0.0.1:${port}`,
    headers: { initial: 'true' },
  });
  t.true(gotInitialHeader);

  await connection.setHeaders({ update: 'true' });
  // Create a worker so it starts polling for activities so we can check our mock server got the "update" header
  const worker = await Worker.create({ connection, taskQueue: 'tq', activities: { async noop() {} } });
  await Promise.all([firstValueFrom(updateSubject).then(() => worker.shutdown()), worker.run()]);
});
