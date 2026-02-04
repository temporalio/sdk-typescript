import * as http from 'http';
import * as http2 from 'http2';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { WorkflowClient } from '@temporalio/client';
import { Runtime } from '@temporalio/worker';
import { TestWorkflowEnvironment, Worker } from './helpers';
import * as workflows from './workflows';

async function withFakeGrpcServer(
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
        if (requestListener) requestListener(req, res);
        res.statusCode = 200;
        res.addTrailers({
          'grpc-status': '0',
          'grpc-message': 'OK',
        });
        res.write(
          // This is a raw gRPC response, of length 0
          new Uint8Array([
            // Frame Type: Data; Not Compressed
            0,
            // Message Length: 0
            0, 0, 0, 0,
          ])
        );
        res.end();
      });
      fn(addr.port)
        .catch((e) => reject(e))
        .finally(() => {
          resolve();

          // The OTel exporter will try to flush metrics on drop, which may result in tons of ERROR
          // messages on the console if the server has had time to complete shutdown before then.
          // Delaying closing the server by 1 second is enough to avoid that situation, and doesn't
          // need to be awaited, no that doesn't slow down tests.
          setTimeout(() => {
            srv.close();
          }, 1000).unref();
        });
    });
  });
}

async function withHttpServer(
  fn: (port: number) => Promise<void>,
  requestListener?: (request: http.IncomingMessage) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const srv = http.createServer();
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const addr = srv.address();
      if (typeof addr === 'string' || addr === null) {
        throw new Error('Unexpected server address type');
      }
      srv.on('request', async (req, res) => {
        if (requestListener) await requestListener(req);
        res.statusCode = 200;
        res.end();
      });
      fn(addr.port)
        .catch((e) => reject(e))
        .finally(() => {
          resolve();

          // The OTel exporter will try to flush metrics on drop, which may result in tons of ERROR
          // messages on the console if the server has had time to complete shutdown before then.
          // Delaying closing the server by 1 second is enough to avoid that situation, and doesn't
          // need to be awaited, no that doesn't slow down tests.
          setTimeout(() => {
            srv.close();
          }, 1000).unref();
        });
    });
  });
}

test.serial('Runtime.install() throws meaningful error when passed invalid metrics.otel.url', async (t) => {
  t.throws(() => Runtime.install({ telemetryOptions: { metrics: { otel: { url: ':invalid' } } } }), {
    instanceOf: TypeError,
    message: /metricsExporter.otel.url/,
  });
});

test.serial('Runtime.install() accepts metrics.otel.url without headers', async (t) => {
  try {
    Runtime.install({ telemetryOptions: { metrics: { otel: { url: 'http://127.0.0.1:1234' } } } });
    t.pass();
  } finally {
    // Cleanup the runtime so that it doesn't interfere with other tests
    await Runtime._instance?.shutdown();
  }
});

test.serial('Exporting OTEL metrics from Core works', async (t) => {
  let resolveCapturedRequest = (_req: http2.Http2ServerRequest) => undefined as void;
  const capturedRequest = new Promise<http2.Http2ServerRequest>((r) => (resolveCapturedRequest = r));
  try {
    await withFakeGrpcServer(async (port: number) => {
      Runtime.install({
        telemetryOptions: {
          metrics: {
            otel: {
              url: `http://127.0.0.1:${port}`,
              headers: {
                'x-test-header': 'test-value',
              },
              metricsExportInterval: 10,
            },
          },
        },
      });

      const localEnv = await TestWorkflowEnvironment.createLocal();
      try {
        const worker = await Worker.create({
          connection: localEnv.nativeConnection,
          workflowsPath: require.resolve('./workflows'),
          taskQueue: 'test-otel',
        });
        const client = new WorkflowClient({
          connection: localEnv.connection,
        });
        await worker.runUntil(async () => {
          await client.execute(workflows.successString, {
            taskQueue: 'test-otel',
            workflowId: uuid4(),
          });
          const req = await Promise.race([
            capturedRequest,
            await new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
          ]);
          t.truthy(req);
          t.is(req?.url, '/opentelemetry.proto.collector.metrics.v1.MetricsService/Export');
          t.is(req?.headers['x-test-header'], 'test-value');
        });
      } finally {
        await localEnv.teardown();
      }
    }, resolveCapturedRequest);
  } finally {
    // Cleanup the runtime so that it doesn't interfere with other tests
    await Runtime._instance?.shutdown();
  }
});

test.serial('Exporting OTEL metrics using OTLP/HTTP from Core works', async (t) => {
  let resolveCapturedRequest = (_req: http.IncomingMessage) => undefined as void;
  const capturedRequest = new Promise<http.IncomingMessage>((r) => (resolveCapturedRequest = r));
  try {
    await withHttpServer(async (port: number) => {
      Runtime.install({
        telemetryOptions: {
          metrics: {
            otel: {
              url: `http://127.0.0.1:${port}/v1/metrics`,
              http: true,
              headers: {
                'x-test-header': 'test-value',
              },
              metricsExportInterval: 10,
            },
          },
        },
      });

      const localEnv = await TestWorkflowEnvironment.createLocal();
      try {
        const worker = await Worker.create({
          connection: localEnv.nativeConnection,
          workflowsPath: require.resolve('./workflows'),
          taskQueue: 'test-otel',
        });
        const client = new WorkflowClient({
          connection: localEnv.connection,
        });
        await worker.runUntil(async () => {
          await client.execute(workflows.successString, {
            taskQueue: 'test-otel',
            workflowId: uuid4(),
          });
          const req = await Promise.race([
            capturedRequest,
            await new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
          ]);
          t.truthy(req);
          t.is(req?.url, '/v1/metrics');
          t.is(req?.headers['x-test-header'], 'test-value');
        });
      } finally {
        await localEnv.teardown();
      }
    }, resolveCapturedRequest);
  } finally {
    // Cleanup the runtime so that it doesn't interfere with other tests
    await Runtime._instance?.shutdown();
  }
});
