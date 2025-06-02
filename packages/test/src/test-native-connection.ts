import { randomUUID } from 'node:crypto';
import util from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import test from 'ava';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Client, NamespaceNotFoundError, WorkflowNotFoundError } from '@temporalio/client';
import { IllegalStateError, NativeConnection, TransportError } from '@temporalio/worker';
import { temporal } from '@temporalio/proto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
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

async function bindLocalhostTls(server: grpc.Server): Promise<number> {
  const caCert = await fs.readFile(path.resolve(__dirname, `../tls_certs/test-ca.crt`));
  const serverChainCert = await fs.readFile(path.resolve(__dirname, `../tls_certs/test-server-chain.crt`));
  const serverKey = await fs.readFile(path.resolve(__dirname, `../tls_certs/test-server.key`));
  const credentials = grpc.ServerCredentials.createSsl(
    caCert,
    [
      {
        cert_chain: serverChainCert,
        private_key: serverKey,
      },
    ],
    false
  );
  return await util.promisify(server.bindAsync.bind(server))('127.0.0.1:0', credentials);
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
    message: /tls\.clientTlsConfig\.clientCert: Missing property 'clientCert'/,
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
      _call: grpc.ServerUnaryCall<
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
  server.forceShutdown();
});

test('Can configure TLS + call credentials', async (t) => {
  let gotRequest = false;
  const server = new grpc.Server();
  server.addService(workflowServiceProtoDescriptor.temporal.api.workflowservice.v1.WorkflowService.service, {
    getSystemInfo(
      _call: grpc.ServerUnaryCall<
        temporal.api.workflowservice.v1.IGetSystemInfoRequest,
        temporal.api.workflowservice.v1.IGetSystemInfoResponse
      >,
      callback: grpc.sendUnaryData<temporal.api.workflowservice.v1.IGetSystemInfoResponse>
    ) {
      gotRequest = true;
      callback(null, {});
    },
  });

  const port = await bindLocalhostTls(server);
  const connection = await NativeConnection.connect({
    address: `127.0.0.1:${port}`,
    tls: {
      serverRootCACertificate: await fs.readFile(path.resolve(__dirname, `../tls_certs/test-ca.crt`)),
      clientCertPair: {
        crt: await fs.readFile(path.resolve(__dirname, `../tls_certs/test-client-chain.crt`)),
        key: await fs.readFile(path.resolve(__dirname, `../tls_certs/test-client.key`)),
      },
      serverNameOverride: 'server',
    },
  });

  t.true(gotRequest);
  await connection.close();
  server.forceShutdown();
});

test('withMetadata and withDeadline propagate metadata and deadline', async (t) => {
  const requests = new Array<{ metadata: grpc.Metadata; deadline: grpc.Deadline }>();
  const server = new grpc.Server();
  server.addService(workflowServiceProtoDescriptor.temporal.api.workflowservice.v1.WorkflowService.service, {
    getSystemInfo(
      call: grpc.ServerUnaryCall<
        temporal.api.workflowservice.v1.IGetSystemInfoRequest,
        temporal.api.workflowservice.v1.IGetSystemInfoResponse
      >,
      callback: grpc.sendUnaryData<temporal.api.workflowservice.v1.IGetSystemInfoResponse>
    ) {
      requests.push({ metadata: call.metadata, deadline: call.getDeadline() });
      call.getDeadline();
      callback(null, {});
    },
  });

  const port = await util.promisify(server.bindAsync.bind(server))(
    'localhost:0',
    grpc.ServerCredentials.createInsecure()
  );
  const connection = await NativeConnection.connect({
    address: `127.0.0.1:${port}`,
  });

  await connection.withDeadline(Date.now() + 10_000, () =>
    connection.withMetadata({ test: 'true' }, () => connection.workflowService.getSystemInfo({}))
  );
  t.is(requests.length, 2);
  t.is(requests[1].metadata.get('test').toString(), 'true');
  t.true(typeof requests[1].deadline === 'number' && requests[1].deadline > 5_000);
  await connection.close();
  server.forceShutdown();
});

test('all WorkflowService methods are implemented', async (t) => {
  const server = new grpc.Server();
  const calledMethods = new Set<string>();
  server.addService(
    workflowServiceProtoDescriptor.temporal.api.workflowservice.v1.WorkflowService.service,
    new Proxy(
      {},
      {
        get() {
          return (
            call: grpc.ServerUnaryCall<any, any>,
            callback: grpc.sendUnaryData<temporal.api.workflowservice.v1.IGetSystemInfoResponse>
          ) => {
            const parts = call.getPath().split('/');
            const method = parts[parts.length - 1];
            calledMethods.add(method[0].toLowerCase() + method.slice(1));
            callback(null, {});
          };
        },
      }
    )
  );

  const port = await util.promisify(server.bindAsync.bind(server))(
    'localhost:0',
    grpc.ServerCredentials.createInsecure()
  );
  const connection = await NativeConnection.connect({
    address: `127.0.0.1:${port}`,
  });

  // Transform all methods from pascal case to lower case.
  const methods = Object.keys(
    workflowServiceProtoDescriptor.temporal.api.workflowservice.v1.WorkflowService.service
  ).map((k) => k[0].toLowerCase() + k.slice(1));
  methods.sort();
  for (const method of methods) {
    await (connection.workflowService as any)[method]({});
    t.true(calledMethods.has(method), `method ${method} not called`);
  }

  await connection.close();
  server.forceShutdown();
});

test('can power client calls', async (t) => {
  const env = await TestWorkflowEnvironment.createLocal();
  try {
    {
      const client = new Client({ connection: env.nativeConnection });
      const handle = await client.workflow.start('dont-care', {
        workflowId: t.title + '-' + randomUUID(),
        taskQueue: 'dont-care',
      });
      await handle.terminate();
      const err = await t.throwsAsync(() => handle.terminate(), {
        instanceOf: WorkflowNotFoundError,
      });
      t.is(err?.workflowId, handle.workflowId);
    }
    {
      const client = new Client({ connection: env.nativeConnection, namespace: 'non-existing' });
      const err = await t.throwsAsync(
        () =>
          client.workflow.start('dont-care', {
            workflowId: 'dont-care',
            taskQueue: 'dont-care',
          }),
        {
          instanceOf: NamespaceNotFoundError,
          message: "Namespace not found: 'non-existing'",
        }
      );
      t.is(err?.namespace, 'non-existing');
    }
  } finally {
    await env.teardown();
  }
});
