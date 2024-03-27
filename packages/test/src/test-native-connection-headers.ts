import util from 'node:util';
import path from 'node:path';
import test from 'ava';
import { Subject, firstValueFrom, skip } from 'rxjs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { NativeConnection } from '@temporalio/worker';
import { temporal } from '@temporalio/proto';
import { Worker } from './helpers';

test('NativeConnection passes headers provided in options', async (t) => {
  const packageDefinition = protoLoader.loadSync(
    path.resolve(
      __dirname,
      '../../core-bridge/sdk-core/sdk-core-protos/protos/api_upstream/temporal/api/workflowservice/v1/service.proto'
    ),
    { includeDirs: [path.resolve(__dirname, '../../core-bridge/sdk-core/sdk-core-protos/protos/api_upstream')] }
  );
  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;

  const server = new grpc.Server();
  let gotInitialHeader = false;
  let gotApiKey = false;
  const newValuesSubject = new Subject<void>();

  // Create a mock server to verify headers are actually sent
  server.addService(protoDescriptor.temporal.api.workflowservice.v1.WorkflowService.service, {
    // called on NativeConnection.connect()
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
      const [apiVal] = call.metadata.get('authorization');
      if (apiVal === 'Bearer enchi_cat') {
        gotApiKey = true;
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
      console.log(call.metadata);
      const [value] = call.metadata.get('update');
      if (value === 'true') {
        newValuesSubject.next();
      }
      const [apiVal] = call.metadata.get('authorization');
      if (apiVal === 'Bearer cute_kitty') {
        newValuesSubject.next();
      }
      callback(new Error());
    },
  });
  const port = await util.promisify(server.bindAsync.bind(server))(
    '127.0.0.1:0',
    grpc.ServerCredentials.createInsecure()
  );
  server.start();

  const connection = await NativeConnection.connect({
    address: `127.0.0.1:${port}`,
    metadata: { initial: 'true' },
    apiKey: 'enchi_cat',
  });
  t.true(gotInitialHeader);
  t.true(gotApiKey);

  await connection.setMetadata({ update: 'true' });
  await connection.setApiKey('cute_kitty');
  // Create a worker so it starts polling for activities so we can check our mock server got the "update" header &
  // new api key
  const worker = await Worker.create({
    connection,
    taskQueue: 'tq',
    activities: {
      async noop() {
        /* yes eslint this is meant to be empty */
      },
    },
  });
  await Promise.all([firstValueFrom(newValuesSubject.pipe(skip(1))).then(() => worker.shutdown()), worker.run()]);
});
