# Dynamic Workflow Loading Demo

This demo runs one generic Worker program three times. Each process receives a different
`TEMPORAL_TASK_QUEUE`, loads `bundles/<task-queue>.js`, and polls only that Task Queue. The bundles all
export the same Workflow type, `customerWorkflow`, but each contains a different hardcoded result.

This models selecting an immutable customer Workflow bundle when a Worker process starts. It does not hot-swap
Workflow code in a running Worker.

## Prepare the demo

From the repository root, install and build the workspace if needed, then compile the demo and its Workflow bundles:

```sh
pnpm --filter @temporalio/dynamic-workflow-loading-demo prepare-demo
```

The explicit bundle step creates these ignored build artifacts:

```text
bundles/tenant-alpha.js
bundles/tenant-beta.js
bundles/tenant-gamma.js
```

## Run locally

Start a local Temporal development server:

```sh
temporal server start-dev
```

In a second terminal, launch all three Worker processes:

```sh
pnpm --filter @temporalio/dynamic-workflow-loading-demo workers
```

The runner preserves the current Temporal connection environment and assigns one of these values to each child:

```text
TEMPORAL_TASK_QUEUE=tenant-alpha
TEMPORAL_TASK_QUEUE=tenant-beta
TEMPORAL_TASK_QUEUE=tenant-gamma
```

In a third terminal, start one `customerWorkflow` on every Task Queue concurrently:

```sh
pnpm --filter @temporalio/dynamic-workflow-loading-demo start-workflows
```

The output demonstrates that the same Workflow type was resolved from three different bundles:

```text
tenant-alpha: I am workflow tenant-alpha
tenant-beta: I am workflow tenant-beta
tenant-gamma: I am workflow tenant-gamma
```

Stop the runner with Ctrl-C; it forwards the shutdown signal to all three Workers.

## Connect to another Temporal environment

Connection settings are loaded by `@temporalio/envconfig`. The Worker runner and starter therefore support Temporal
CLI profiles and the standard configuration environment variables, including `TEMPORAL_PROFILE`,
`TEMPORAL_CONFIG_FILE`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, and `TEMPORAL_API_KEY`.

For example:

```sh
TEMPORAL_PROFILE=my-cloud-profile \
  pnpm --filter @temporalio/dynamic-workflow-loading-demo workers
```

Use the same connection configuration when running `start-workflows`.

## Run the tests

```sh
pnpm --filter @temporalio/dynamic-workflow-loading-demo test
```

The tests build all three bundles, exercise the runner's child-process supervision, and execute the common Workflow
type against every bundle using a local Temporal test environment.
