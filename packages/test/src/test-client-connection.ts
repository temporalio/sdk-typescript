import util from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import test from 'ava';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Connection, defaultGrpcRetryOptions, isGrpcServiceError, makeGrpcRetryInterceptor } from '@temporalio/client';
import pkg from '@temporalio/client/lib/pkg';
import { temporal, grpc as grpcProto } from '@temporalio/proto';

const workflowServicePackageDefinition = protoLoader.loadSync(
  path.resolve(
    __dirname,
    '../../core-bridge/sdk-core/protos/api_upstream/temporal/api/workflowservice/v1/service.proto'
  ),
  { includeDirs: [path.resolve(__dirname, '../../core-bridge/sdk-core/protos/api_upstream')] }
);
const workflowServiceProtoDescriptor = grpc.loadPackageDefinition(workflowServicePackageDefinition) as any;

async function bindLocalhost(server: grpc.Server): Promise<number> {
  return await util.promisify(server.bindAsync.bind(server))('127.0.0.1:0', grpc.ServerCredentials.createInsecure());
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
    true
  );
  return await util.promisify(server.bindAsync.bind(server))('localhost:0', credentials);
}

test('withMetadata / withDeadline / withAbortSignal set the CallContext for RPC call', async (t) => {
  const server = new grpc.Server();
  let gotTestHeaders = false;
  let gotDeadline = false;
  const deadline = Date.now() + 10000;

  server.addService(workflowServiceProtoDescriptor.temporal.api.workflowservice.v1.WorkflowService.service, {
    registerNamespace(
      call: grpc.ServerUnaryCall<
        temporal.api.workflowservice.v1.IRegisterNamespaceRequest,
        temporal.api.workflowservice.v1.IRegisterNamespaceResponse
      >,
      callback: grpc.sendUnaryData<temporal.api.workflowservice.v1.IDescribeWorkflowExecutionResponse>
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
    // Simulate a hanging call to test abort signal support.
    updateNamespace() {},
  });
  const port = await bindLocalhost(server);
  server.start();
  const conn = await Connection.connect({ address: `127.0.0.1:${port}`, metadata: { staticKey: 'set' } });
  await conn.withMetadata({ test: 'true' }, () =>
    conn.withMetadata({ otherKey: 'set' }, () =>
      conn.withDeadline(deadline, () => conn.workflowService.registerNamespace({}))
    )
  );
  t.true(gotTestHeaders);
  t.true(gotDeadline);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 10);
  const err = await t.throwsAsync(conn.withAbortSignal(ctrl.signal, () => conn.workflowService.updateNamespace({})));
  t.true(isGrpcServiceError(err) && err.code === grpc.status.CANCELLED);
});

test('healthService works', async (t) => {
  const packageDefinition = protoLoader.loadSync(
    path.resolve(__dirname, '../../core-bridge/sdk-core/protos/grpc/health/v1/health.proto')
  );
  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;

  const server = new grpc.Server();

  server.addService(protoDescriptor.grpc.health.v1.Health.service, {
    check(
      _call: grpc.ServerUnaryCall<grpcProto.health.v1.HealthCheckRequest, grpcProto.health.v1.HealthCheckResponse>,
      callback: grpc.sendUnaryData<grpcProto.health.v1.HealthCheckResponse>
    ) {
      callback(
        null,
        grpcProto.health.v1.HealthCheckResponse.create({
          status: grpcProto.health.v1.HealthCheckResponse.ServingStatus.SERVING,
        })
      );
    },
  });
  const port = await bindLocalhost(server);
  server.start();
  const conn = await Connection.connect({ address: `127.0.0.1:${port}` });
  const response = await conn.healthService.check({});
  t.is(response.status, grpcProto.health.v1.HealthCheckResponse.ServingStatus.SERVING);
});

test('grpc retry passes request and headers on retry, propagates responses', async (t) => {
  let attempt = 0;
  let successAttempt = 3;

  const meta = Array<string>();
  const namespaces = Array<string>();

  const server = new grpc.Server();

  server.addService(workflowServiceProtoDescriptor.temporal.api.workflowservice.v1.WorkflowService.service, {
    describeWorkflowExecution(
      call: grpc.ServerUnaryCall<
        temporal.api.workflowservice.v1.IDescribeWorkflowExecutionRequest,
        temporal.api.workflowservice.v1.IDescribeWorkflowExecutionResponse
      >,
      callback: grpc.sendUnaryData<temporal.api.workflowservice.v1.IDescribeWorkflowExecutionResponse>
    ) {
      const { namespace } = call.request;
      if (typeof namespace === 'string') {
        namespaces.push(namespace);
      }
      const [aValue] = call.metadata.get('a');
      if (typeof aValue === 'string') {
        meta.push(aValue);
      }

      attempt++;
      if (attempt < successAttempt) {
        callback({ code: grpc.status.UNKNOWN });
        return;
      }
      const response: temporal.api.workflowservice.v1.IDescribeWorkflowExecutionResponse = {
        workflowExecutionInfo: { execution: { workflowId: 'test' } },
      };
      callback(null, response);
    },
  });
  const port = await bindLocalhost(server);
  server.start();

  // Default interceptor config with backoff factor of 1 to speed things up
  const interceptor = makeGrpcRetryInterceptor(defaultGrpcRetryOptions({ factor: 1 }));
  const conn = await Connection.connect({
    address: `127.0.0.1:${port}`,
    metadata: { a: 'bc' },
    interceptors: [interceptor],
  });
  const response = await conn.workflowService.describeWorkflowExecution({ namespace: 'a' });
  // Check that response is sent correctly
  t.is(response.workflowExecutionInfo?.execution?.workflowId, 'test');
  t.is(attempt, 3);
  // Check that request is sent correctly in each attempt
  t.deepEqual(namespaces, ['a', 'a', 'a']);
  // Check that metadata is sent correctly in each attempt
  t.deepEqual(meta, ['bc', 'bc', 'bc']);

  // Reset and rerun expecting error in the response
  attempt = 0;
  successAttempt = 11; // never

  await t.throwsAsync(() => conn.workflowService.describeWorkflowExecution({ namespace: 'a' }), {
    message: '2 UNKNOWN: Unknown Error',
  });
  t.is(attempt, 10);
});

test('Default keepalive settings are set while maintaining user provided channelArgs', async (t) => {
  const conn = Connection.lazy({
    channelArgs: { 'grpc.enable_channelz': 1, 'grpc.keepalive_permit_without_calls': 0 },
  });
  const { channelArgs } = conn.options;
  t.is(channelArgs['grpc.keepalive_time_ms'], 30_000);
  t.is(channelArgs['grpc.enable_channelz'], 1);
  // User setting overrides default
  t.is(channelArgs['grpc.keepalive_permit_without_calls'], 0);
});

test('Can configure TLS + call credentials', async (t) => {
  const meta = Array<string[]>();

  const server = new grpc.Server();

  server.addService(workflowServiceProtoDescriptor.temporal.api.workflowservice.v1.WorkflowService.service, {
    getSystemInfo(
      call: grpc.ServerUnaryCall<
        temporal.api.workflowservice.v1.IGetSystemInfoRequest,
        temporal.api.workflowservice.v1.IGetSystemInfoResponse
      >,
      callback: grpc.sendUnaryData<temporal.api.workflowservice.v1.IGetSystemInfoResponse>
    ) {
      const [aValue] = call.metadata.get('a');
      const [authorizationValue] = call.metadata.get('authorization');
      if (typeof aValue === 'string' && typeof authorizationValue === 'string') {
        meta.push([aValue, authorizationValue]);
      }

      const response: temporal.api.workflowservice.v1.IGetSystemInfoResponse = {
        serverVersion: 'test',
        capabilities: undefined,
      };
      callback(null, response);
    },

    describeWorkflowExecution(
      call: grpc.ServerUnaryCall<
        temporal.api.workflowservice.v1.IDescribeWorkflowExecutionRequest,
        temporal.api.workflowservice.v1.IDescribeWorkflowExecutionResponse
      >,
      callback: grpc.sendUnaryData<temporal.api.workflowservice.v1.IDescribeWorkflowExecutionResponse>
    ) {
      const [aValue] = call.metadata.get('a');
      const [authorizationValue] = call.metadata.get('authorization');
      if (typeof aValue === 'string' && typeof authorizationValue === 'string') {
        meta.push([aValue, authorizationValue]);
      }

      const response: temporal.api.workflowservice.v1.IDescribeWorkflowExecutionResponse = {
        workflowExecutionInfo: { execution: { workflowId: 'test' } },
      };
      callback(null, response);
    },
  });
  const port = await bindLocalhostTls(server);
  server.start();

  let callNumber = 0;
  const oauth2Client: grpc.OAuth2Client = {
    getRequestHeaders: async () => {
      const accessToken = `oauth2-access-token-${++callNumber}`;
      return { authorization: `Bearer ${accessToken}` };
    },
  };

  // Default interceptor config with backoff factor of 1 to speed things up
  // const interceptor = makeGrpcRetryInterceptor(defaultGrpcRetryOptions({ factor: 1 }));
  const conn = await Connection.connect({
    address: `localhost:${port}`,
    metadata: { a: 'bc' },
    tls: {
      serverRootCACertificate: await fs.readFile(path.resolve(__dirname, `../tls_certs/test-ca.crt`)),
      clientCertPair: {
        crt: await fs.readFile(path.resolve(__dirname, `../tls_certs/test-client-chain.crt`)),
        key: await fs.readFile(path.resolve(__dirname, `../tls_certs/test-client.key`)),
      },
      serverNameOverride: 'Server',
    },
    callCredentials: [grpc.credentials.createFromGoogleCredential(oauth2Client)],
  });

  // Make three calls
  await conn.workflowService.describeWorkflowExecution({ namespace: 'a' });
  await conn.workflowService.describeWorkflowExecution({ namespace: 'b' });
  await conn.workflowService.describeWorkflowExecution({ namespace: 'c' });

  // Check that both connection level metadata and call credentials metadata are sent correctly
  t.deepEqual(meta, [
    ['bc', 'Bearer oauth2-access-token-1'],
    ['bc', 'Bearer oauth2-access-token-2'],
    ['bc', 'Bearer oauth2-access-token-3'],
    ['bc', 'Bearer oauth2-access-token-4'],
  ]);
});
