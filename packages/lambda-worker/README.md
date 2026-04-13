# lambda-worker

A wrapper for running [Temporal](https://temporal.io) workers inside AWS Lambda. A single
`runWorker` call handles the full per-invocation lifecycle: connecting to the Temporal server,
creating a worker with Lambda-tuned defaults, polling for tasks, and gracefully shutting down before
the invocation deadline.

## Quick start

```typescript
// handler.ts
import { runWorker } from '@temporalio/lambda-worker';
import * as activities from './activities';

export const handler = runWorker({ deploymentName: 'my-service', buildId: 'v1.0' }, (config) => {
  config.workerOptions.taskQueue = 'my-task-queue';
  config.workerOptions.workflowBundle = { code: require('./workflow-bundle.js') };
  config.workerOptions.activities = activities;
});
```

Prefer `workflowBundle` (pre-bundled with `bundleWorkflowCode`) over `workflowsPath` to avoid
webpack bundling overhead on Lambda cold starts.

## Configuration

Client connection settings (address, namespace, TLS, API key) are loaded automatically from a TOML
config file and/or environment variables via `@temporalio/envconfig`. The config file is resolved in
order:

1. `TEMPORAL_CONFIG_FILE` env var, if set.
2. `temporal.toml` in `$LAMBDA_TASK_ROOT` (typically `/var/task`).
3. `temporal.toml` in the current working directory.

The file is optional -- if absent, only environment variables are used.

The configure callback receives a `LambdaWorkerConfig` object with fields pre-populated with
Lambda-appropriate defaults. Override any field directly in the callback. The `taskQueue` in
`workerOptions` is pre-populated from the `TEMPORAL_TASK_QUEUE` environment variable if set.

## Lambda-tuned worker defaults

The package applies conservative concurrency limits suited to Lambda's resource constraints:

| Setting                                | Default            |
| -------------------------------------- | ------------------ |
| `maxConcurrentActivityTaskExecutions`  | 2                  |
| `maxConcurrentWorkflowTaskExecutions`  | 10                 |
| `maxConcurrentLocalActivityExecutions` | 2                  |
| `maxConcurrentNexusTaskExecutions`     | 5                  |
| `workflowTaskPollerBehavior`           | `SimpleMaximum(2)` |
| `activityTaskPollerBehavior`           | `SimpleMaximum(1)` |
| `nexusTaskPollerBehavior`              | `SimpleMaximum(1)` |
| `shutdownGraceTime`                    | 5 seconds          |
| `maxCachedWorkflows`                   | 30                 |

Worker Deployment Versioning is always enabled. The default versioning behavior is `PINNED`; to
change it, override `workerDeploymentOptions.defaultVersioningBehavior` in the configure callback:

```typescript
config.workerOptions.workerDeploymentOptions = {
  defaultVersioningBehavior: 'AUTO_UPGRADE',
};
```

## Logging

The Temporal `Runtime` is installed automatically by `runWorker`. If
[`@aws-lambda-powertools/logger`](https://docs.aws.amazon.com/powertools/typescript/latest/features/logger/)
is installed, the runtime is configured with a `PowertoolsLoggerAdapter` that produces structured
JSON output automatically parsed by CloudWatch Logs. If Powertools is not installed, the SDK's
default human-readable logger is used.

To customize the logger or other runtime options, modify `config.runtimeOptions` in the configure
callback:

```typescript
export const handler = runWorker({ deploymentName: 'my-service', buildId: 'v1.0' }, (config) => {
  config.workerOptions.taskQueue = 'my-task-queue';
  // Use a custom logger
  config.runtimeOptions.logger = myCustomLogger;
  // Or configure telemetry
  config.runtimeOptions.telemetryOptions = { ... };
});
```

Shutdown signals are disabled by default (`shutdownSignals: []`) since Lambda manages its own
lifecycle.

## Observability

Metrics and tracing are opt-in. The `otel` module provides convenience helpers for AWS Distro for
OpenTelemetry (ADOT):

```typescript
import { runWorker } from '@temporalio/lambda-worker';
import { applyDefaults } from '@temporalio/lambda-worker/otel';
import * as activities from './activities';

export const handler = runWorker({ deploymentName: 'my-service', buildId: 'v1.0' }, (config) => {
  applyDefaults(config);
  config.workerOptions.taskQueue = 'my-task-queue';
  config.workerOptions.workflowBundle = { code: require('./workflow-bundle.js') };
  config.workerOptions.activities = activities;
});
```

You can also use `applyTracing` individually with a custom `TracerProvider`.

If you use OTEL, you can use
[ADOT](https://aws-otel.github.io/docs/getting-started/lambda/lambda-js) (the AWS Distro For
OpenTelemetry) to automatically integrate with AWS observability functionality. Namely, you will
want to add the Lambda layer in the aforementioned link. We'll handle setting up the SDK for you.
