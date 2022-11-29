import fs from 'fs';
import http from 'http';
import { inspect } from 'util';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import * as opentelemetry from '@opentelemetry/sdk-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import arg from 'arg';
import { LogLevel, TelemetryOptions } from '@temporalio/core-bridge';
import { Connection } from '@temporalio/client';
import {
  DefaultLogger,
  LogEntry,
  NativeConnection,
  Runtime,
  Worker,
  makeTelemetryFilterString,
} from '@temporalio/worker';
import * as activities from '../activities';
import { ConnectionInjectorInterceptor } from '../activities/interceptors';
import { getRequired, WorkerArgSpec, workerArgSpec } from './args';

/**
 * Optionally start the opentelemetry node SDK
 */
async function withOptionalOtel(args: arg.Result<WorkerArgSpec>, fn: () => Promise<any>): Promise<void> {
  const url = args['--otel-url'];
  const taskQueue = getRequired(args, '--task-queue');

  if (!url) {
    await fn();
    return;
  }

  const traceExporter = new OTLPTraceExporter({ url });
  const otel = new opentelemetry.NodeSDK({
    resource: new opentelemetry.resources.Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'load-worker',
      taskQueue,
    }),
    traceExporter,
  });
  await otel.start();
  try {
    await fn();
  } finally {
    // Ignore otel shutdown errors to avoid hiding errors in "try" scope
    await otel.shutdown().catch(console.error);
  }
}

/**
 * Optionally start an HTTP server to expose Worker status
 */
async function withOptionalStatusServer(
  worker: Worker,
  port: number | undefined,
  fn: () => Promise<any>
): Promise<void> {
  if (port == null) {
    await fn();
    return;
  }

  const server = await new Promise<http.Server>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, 'Method not allowed');
        res.end();
        return;
      }
      if (req.url !== '/') {
        res.writeHead(404, 'Not found');
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.write(JSON.stringify(worker.getStatus()));
      res.end();
    });
    server.listen(port, () => resolve(server));
    server.once('error', reject);
  });
  console.log('Status server listening on', server?.address());
  try {
    await fn();
  } finally {
    server.close();
  }
}

function createLogFunction(stream: fs.WriteStream) {
  return (entry: LogEntry) => {
    const { level, timestampNanos, message, meta } = entry;

    const date = new Date(Number(timestampNanos / 1_000_000n));
    if (meta === undefined) {
      stream.write(`${date.toISOString()} [${level}] ${message}\n`);
    } else {
      stream.write(`${date.toISOString()} [${level}] ${message} ${inspect(meta)}\n`);
    }
  };
}

async function main() {
  const args = arg<WorkerArgSpec>(workerArgSpec);
  const maxConcurrentActivityTaskExecutions = args['--max-concurrent-at-executions'] ?? 100;
  const maxConcurrentWorkflowTaskExecutions = args['--max-concurrent-wft-executions'] ?? 100;
  const maxConcurrentLocalActivityExecutions = args['--max-concurrent-la-executions'] ?? 100;
  const maxCachedWorkflows = args['--max-cached-wfs'];
  const oTelUrl = args['--otel-url'];
  const logLevel = (args['--log-level'] || 'INFO').toUpperCase();
  const logFile = args['--log-file'];
  const serverAddress = getRequired(args, '--server-address');
  const namespace = getRequired(args, '--ns');
  const taskQueue = getRequired(args, '--task-queue');
  const statusPort = args['--status-port'];
  const shutdownGraceTime = args['--shutdown-grace-time'] || '30s';

  const telemetryOptions: TelemetryOptions = {
    logging: {
      filter: makeTelemetryFilterString({ core: logLevel as LogLevel }),
      forward: {},
    },
    ...(oTelUrl
      ? {
          filter: makeTelemetryFilterString({ core: logLevel as LogLevel }),
          tracing: {
            otel: { url: oTelUrl },
          },
        }
      : undefined),
  };

  const logger = logFile
    ? new DefaultLogger(logLevel as any, createLogFunction(fs.createWriteStream(logFile, 'utf8')))
    : new DefaultLogger(logLevel as any);
  Runtime.install({
    telemetryOptions,
    logger,
  });

  const clientConnection = await Connection.connect({
    address: serverAddress,
  });

  const connection = await NativeConnection.connect({
    address: serverAddress,
  });

  await withOptionalOtel(args, async () => {
    const worker = await Worker.create({
      connection,
      namespace,
      activities,
      workflowsPath: require.resolve('../workflows'),
      taskQueue,
      maxConcurrentActivityTaskExecutions,
      maxConcurrentLocalActivityExecutions,
      maxConcurrentWorkflowTaskExecutions,
      maxCachedWorkflows,
      shutdownGraceTime,
      interceptors: {
        activityInbound: [() => new ConnectionInjectorInterceptor(clientConnection)],
      },
    });

    await withOptionalStatusServer(worker, statusPort, async () => {
      const interval = setInterval(() => logger.info('worker status', worker.getStatus()), 30_000);
      try {
        await worker.run();
      } finally {
        clearInterval(interval);
        await connection.close();
      }
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
