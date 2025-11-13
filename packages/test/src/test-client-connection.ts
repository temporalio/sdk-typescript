import { fork } from 'node:child_process';
import * as http2 from 'node:http2';
import * as util from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import assert from 'node:assert';
import test, { TestFn } from 'ava';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
  Client,
  Connection,
  defaultGrpcRetryOptions,
  isGrpcCancelledError,
  isGrpcServiceError,
  isRetryableError,
  makeGrpcRetryInterceptor,
} from '@temporalio/client';
import pkg from '@temporalio/client/lib/pkg';
import { temporal, grpc as grpcProto } from '@temporalio/proto';

const workflowServicePackageDefinition = protoLoader.loadSync(
  path.resolve(
    __dirname,
    '../../core-bridge/sdk-core/crates/common/protos/api_upstream/temporal/api/workflowservice/v1/service.proto'
  ),
  { includeDirs: [path.resolve(__dirname, '../../core-bridge/sdk-core/crates/common/protos/api_upstream')] }
);
const workflowServiceProtoDescriptor = grpc.loadPackageDefinition(workflowServicePackageDefinition) as any;

const healthServicePackageDefinition = protoLoader.loadSync(
  path.resolve(__dirname, '../../core-bridge/sdk-core/crates/common/protos/grpc/health/v1/health.proto')
);
const healthServicePackageDescriptor = grpc.loadPackageDefinition(healthServicePackageDefinition) as any;

async function bindLocalhost(server: grpc.Server): Promise<number> {
  return await util.promisify(server.bindAsync.bind(server))('127.0.0.1:0', grpc.ServerCredentials.createInsecure());
}

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
    true
  );
  return await util.promisify(server.bindAsync.bind(server))('127.0.0.1:0', credentials);
}

test('withMetadata / withDeadline / withAbortSignal set the CallContext for RPC call', async (t) => {
  let gotTestHeaders = false;
  let gotStaticBinValue;
  let gotOtherBinValue;
  let gotDeadline = false;
  const authTokens: string[] = [];
  const deadline = Date.now() + 10000;

  const server = new grpc.Server();
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
      const [auth] = call.metadata.get('Authorization');
      if (
        testValue === 'true' &&
        otherValue === 'set' &&
        staticValue === 'set' &&
        clientName === 'temporal-typescript' &&
        clientVersion === pkg.version &&
        auth === 'Bearer test-token'
      ) {
        gotTestHeaders = true;
      }
      gotStaticBinValue = call.metadata.get('staticKey-bin');
      gotOtherBinValue = call.metadata.get('otherKey-bin');
      const receivedDeadline = call.getDeadline();
      // For some reason the deadline the server gets is slightly different from the one we send in the client
      if (typeof receivedDeadline === 'number' && receivedDeadline >= deadline && receivedDeadline - deadline < 1000) {
        gotDeadline = true;
      }
      callback(null, {});
    },
    startWorkflowExecution(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      const [auth] = call.metadata.get('Authorization');
      authTokens.push(auth.toString());
      callback(null, {});
    },
    updateNamespace() {
      // Simulate a hanging call to test abort signal support.
    },
  });
  const port = await bindLocalhost(server);
  const conn = await Connection.connect({
    address: `127.0.0.1:${port}`,
    metadata: { staticKey: 'set', 'staticKey-bin': Buffer.from([0x00]) },
    apiKey: 'test-token',
  });
  await conn.withMetadata({ test: 'true' }, () =>
    conn.withMetadata({ otherKey: 'set', 'otherKey-bin': Buffer.from([0x01]) }, () =>
      conn.withDeadline(deadline, () => conn.workflowService.registerNamespace({}))
    )
  );
  t.true(gotTestHeaders);
  t.true(gotDeadline);
  t.deepEqual(gotStaticBinValue, [Buffer.from([0x00])]);
  t.deepEqual(gotOtherBinValue, [Buffer.from([0x01])]);
  await conn.withApiKey('tt-2', () => conn.workflowService.startWorkflowExecution({}));
  conn.setApiKey('tt-3');
  await conn.workflowService.startWorkflowExecution({});
  const nextTTs = ['tt-4', 'tt-5'];
  conn.setApiKey(() => nextTTs.shift()!);
  await conn.workflowService.startWorkflowExecution({});
  await conn.workflowService.startWorkflowExecution({});
  t.deepEqual(authTokens, ['Bearer tt-2', 'Bearer tt-3', 'Bearer tt-4', 'Bearer tt-5']);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 10);
  const err = await t.throwsAsync(conn.withAbortSignal(ctrl.signal, () => conn.workflowService.updateNamespace({})));
  t.true(isGrpcCancelledError(err));
});

test('apiKey sets temporal-namespace header appropriately', async (t) => {
  let getSystemInfoHeaders: grpc.Metadata = new grpc.Metadata();
  let startWorkflowExecutionHeaders: grpc.Metadata = new grpc.Metadata();

  const server = new grpc.Server();
  server.addService(workflowServiceProtoDescriptor.temporal.api.workflowservice.v1.WorkflowService.service, {
    getSystemInfo(
      call: grpc.ServerUnaryCall<
        temporal.api.workflowservice.v1.IGetSystemInfoRequest,
        temporal.api.workflowservice.v1.IGetSystemInfoResponse
      >,
      callback: grpc.sendUnaryData<temporal.api.workflowservice.v1.IGetSystemInfoResponse>
    ) {
      getSystemInfoHeaders = call.metadata.clone();
      callback(null, {});
    },
    startWorkflowExecution(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      startWorkflowExecutionHeaders = call.metadata.clone();
      callback(null, {});
    },
  });
  const port = await bindLocalhost(server);
  const conn = await Connection.connect({
    address: `127.0.0.1:${port}`,
    metadata: { staticKey: 'set' },
    apiKey: 'test-token',
  });

  await conn.workflowService.startWorkflowExecution({ namespace: 'test-namespace' });

  assert(getSystemInfoHeaders !== undefined);
  t.deepEqual(getSystemInfoHeaders.get('temporal-namespace'), []);
  t.deepEqual(getSystemInfoHeaders.get('authorization'), ['Bearer test-token']);
  t.deepEqual(getSystemInfoHeaders.get('staticKey'), ['set']);

  assert(startWorkflowExecutionHeaders);
  t.deepEqual(startWorkflowExecutionHeaders.get('temporal-namespace'), ['test-namespace']);
  t.deepEqual(startWorkflowExecutionHeaders.get('authorization'), ['Bearer test-token']);
  t.deepEqual(startWorkflowExecutionHeaders.get('staticKey'), ['set']);
});

test('Connection can connect using "[ipv6]:port" address', async (t) => {
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
  const connection = await Connection.connect({
    address: `[::1]:${port}`,
  });
  await new Client({ connection });
  t.true(gotRequest);
});

test('healthService works', async (t) => {
  const server = new grpc.Server();
  server.addService(healthServicePackageDescriptor.grpc.health.v1.Health.service, {
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
    address: `127.0.0.1:${port}`,
    metadata: { a: 'bc' },
    tls: {
      serverRootCACertificate: await fs.readFile(path.resolve(__dirname, `../tls_certs/test-ca.crt`)),
      clientCertPair: {
        crt: await fs.readFile(path.resolve(__dirname, `../tls_certs/test-client-chain.crt`)),
        key: await fs.readFile(path.resolve(__dirname, `../tls_certs/test-client.key`)),
      },
      serverNameOverride: 'server',
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

{
  const testWithRejectingServer = test as TestFn<{
    rejectingServer: {
      server: grpc.Server;
      port: number;
      attemptsPerRequestId: Record<string, number>;
    };
  }>;

  testWithRejectingServer.before(async (t) => {
    const server = new grpc.Server();
    server.addService(workflowServiceProtoDescriptor.temporal.api.workflowservice.v1.WorkflowService.service, {
      describeWorkflowExecution(
        call: grpc.ServerUnaryCall<
          temporal.api.workflowservice.v1.IDescribeWorkflowExecutionRequest,
          temporal.api.workflowservice.v1.IDescribeWorkflowExecutionResponse
        >,
        callback: grpc.sendUnaryData<temporal.api.workflowservice.v1.IDescribeWorkflowExecutionResponse>
      ) {
        const [requestId] = call.metadata.get('request-id') as string[];
        const [statusCode] = call.metadata.get('status-code') as string[];
        t.context.rejectingServer.attemptsPerRequestId[requestId] =
          (t.context.rejectingServer.attemptsPerRequestId[requestId] ?? 0) + 1;
        callback({ code: Number(statusCode) });
      },
    });
    const port = await bindLocalhost(server);
    t.context.rejectingServer = { server, port, attemptsPerRequestId: {} };
  });

  testWithRejectingServer.after((t) => {
    t.context.rejectingServer.server.forceShutdown();
  });

  // Refer to grpc.status for list and description of status codes.
  for (let grpcStatusCode = 1; grpcStatusCode < 16; grpcStatusCode++) {
    testWithRejectingServer(
      `Retry policy is correctly applied on Client Connection (gRPC status code ${grpcStatusCode})`,
      async (t) => {
        const requestId = `request-${grpcStatusCode}`;

        const conn = await Connection.connect({
          address: `127.0.0.1:${t.context.rejectingServer.port}`,
          interceptors: [
            makeGrpcRetryInterceptor(
              // initialInterval divided by 10 compared to actual defaults, and backoff factor set to 1,
              // both to speed things up. Also, no jitter, to make the test slightly more predictable.
              defaultGrpcRetryOptions({
                factor: 1,
                maxJitter: 0,
                maxAttempts: 10,
                initialIntervalMs(status) {
                  return status.code === grpc.status.RESOURCE_EXHAUSTED ? 100 : 10;
                },
              })
            ),
          ],
          metadata: {
            'request-id': requestId,
            'status-code': String(grpcStatusCode),
          },
        });

        try {
          const startTime = Date.now();
          const err = await t.throwsAsync(() => conn.workflowService.describeWorkflowExecution({}), {
            message: (s) => s.startsWith(String(grpcStatusCode)),
          });
          if (!err || !isGrpcServiceError(err)) {
            return t.fail(`Expected a grpc service error, got ${err}`);
          }

          const expectedAttempts = isRetryableError(err) ? 10 : 1;
          const actualAttempts = t.context.rejectingServer.attemptsPerRequestId[requestId];
          t.is(actualAttempts, expectedAttempts);

          const expectedMinDuration =
            (expectedAttempts - 1) * (grpcStatusCode === grpc.status.RESOURCE_EXHAUSTED ? 100 : 10);
          // Here, we really just want to confirm that gRPC is not playing tricks on us by adding
          // extra wait time over our own retry policy's backoff. But being too strict may cause
          // flakes on very busy CI. Hence, we allow for very generous overhead.
          // Allow an overhead of 500ms for the first attempt, then 200ms per retry.
          const expectedMaxDuration = expectedMinDuration + 500 + (expectedAttempts - 1) * 200;
          const actualDuration = Date.now() - startTime;
          t.true(
            actualDuration >= expectedMinDuration,
            `Expected total duration to be less than ${expectedMinDuration}ms; got ${actualDuration}ms`
          );
          t.true(
            actualDuration <= expectedMaxDuration,
            `Expected total duration to be at most ${expectedMaxDuration}ms; got ${actualDuration}ms`
          );
        } finally {
          await conn.close();
        }
      }
    );
  }
}

// See https://github.com/temporalio/sdk-typescript/issues/1023
test('No 10s delay on close due to grpc-js', async (t) => {
  const server = new grpc.Server();
  try {
    server.addService(workflowServiceProtoDescriptor.temporal.api.workflowservice.v1.WorkflowService.service, {});
    const port = await bindLocalhost(server);
    const script = `
      const { Connection } = require("@temporalio/client");
      Connection.connect({ address: '127.0.0.1:${port}' }).catch(console.log);
    `;
    const startTime = Date.now();
    await new Promise((resolve, reject) => {
      try {
        const childProcess = fork('-e', [script]);
        childProcess.on('exit', resolve);
        childProcess.on('error', reject);
      } catch (e) {
        reject(e);
      }
    });
    const duration = Date.now() - startTime;
    t.true(duration < 5000, `Expected duration to be less than 5s, got ${duration / 1000}s`);
  } finally {
    server.forceShutdown();
  }
});

test('Retry on "RST_STREAM with code 0"', async (t) => {
  let receivedRequests = 0;
  const requestHandler = (_req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
    if (++receivedRequests < 4) {
      // Just a 200 OK response, without the mandatory gRPC headers
      res.writeHead(200);
      res.end();
    } else {
      // This time, send a complete gRPC response
      res.statusCode = 200;
      res.addTrailers({
        'grpc-status': '0',
        'grpc-message': 'OK',
      });
      res.write(
        // This is a raw gRPC response, of length 0
        Buffer.from([
          // Frame Type: Data; Not Compressed
          0,
          // Message Length: 0
          0, 0, 0, 0,
        ])
      );
      res.end();
    }
  };

  await withHttp2Server(async (port) => {
    const connection = await Connection.connect({ address: `127.0.0.1:${port}` });
    try {
      await new Client({ connection });
      t.is(receivedRequests, 4);
    } finally {
      await connection.close();
    }
  }, requestHandler);
});

test('Retry on "RST_STREAM with code 2"', async (t) => {
  let receivedRequests = 0;

  const requestHandler = (_req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
    if (++receivedRequests < 4) {
      // Sends a RST_STREAM with code 2
      res.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    } else {
      // This time, send a complete gRPC response
      res.statusCode = 200;
      res.addTrailers({
        'grpc-status': '0',
        'grpc-message': 'OK',
      });
      res.write(
        // This is a raw gRPC response, of length 0
        Buffer.from([
          // Frame Type: Data; Not Compressed
          0,
          // Message Length: 0
          0, 0, 0, 0,
        ])
      );
      res.end();
    }
  };

  await withHttp2Server(async (port) => {
    const connection = await Connection.connect({
      address: `127.0.0.1:${port}`,
    });
    try {
      await new Client({ connection });
      t.is(receivedRequests, 4);
    } finally {
      await connection.close();
    }
  }, requestHandler);
});

async function withHttp2Server(
  fn: (port: number) => Promise<void>,
  requestListener?: (request: http2.Http2ServerRequest, response: http2.Http2ServerResponse) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const srv = http2.createServer();
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const addr = srv.address();
      if (typeof addr === 'string' || addr === null) {
        throw new Error('Unexpected server address type');
      }
      srv.on('request', async (req, res) => {
        if (requestListener) await requestListener(req, res);
        try {
          res.end();
        } catch (_e) {
          // requestListener may have messed up the HTTP2 connection. Just ignore.
        }
      });
      fn(addr.port)
        .catch((e) => reject(e))
        .finally(() => srv.close((_) => resolve()));
    });
  });
}
