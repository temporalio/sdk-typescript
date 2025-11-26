# `@temporalio/nyc-test-coverage`

[![NPM](https://img.shields.io/npm/v/@temporalio/nyc-test-coverage?style=for-the-badge)](https://www.npmjs.com/package/@temporalio/nyc-test-coverage)

[Temporal](https://temporal.io)'s [TypeScript SDK](https://docs.temporal.io/typescript/introduction) integration for Workflow code coverage with [nyc](https://npmjs.com/package/nyc) and similar tools.

## Getting Started

1. `npm install -D mocha nyc @temporalio/nyc-test-coverage`
1. Instantiate `WorkflowCoverage` from this package, and call `augmentWorkerOptions()` to configure Workflows to gather and export code coverage data:

```ts
import { WorkflowCoverage } from '@temporalio/nyc-test-coverage';

const workflowCoverage = new WorkflowCoverage();

worker = await Worker.create(
  workflowCoverage.augmentWorkerOptions({
    connection: nativeConnection,
    taskQueue,
    workflowsPath: require.resolve('./workflows'),
  })
);
```

3. After your tests are done, call `mergeIntoGlobalCoverage()` to merge your Workflows' code coverage into nyc's global coverage.

```ts
after(() => {
  workflowCoverage.mergeIntoGlobalCoverage();
});
```

## Usage with `bundleWorkflowCode()`

If you are pre-bundling your Workflows using `bundleWorkflowCode()`, we recommend using the `augmentBundleOptions()` method to configure your bundle options, followed by `augmentWorkerOptionsWithBundle()` to configure your Worker options as follows.

```ts
const bundle = await bundleWorkflowCode(
  workflowCoverage.augmentBundleOptions({
    workflowsPath: require.resolve('./workflows'),
  })
);

const worker = await Worker.create(
  workflowCoverage.augmentWorkerOptionsWithBundle({
    connection,
    taskQueue,
    workflowBundle: bundle,
    activities,
  })
);
```

With `bundleWorkflowCode()`, you still need to call `mergeIntoGlobalCoverage()` when your tests are done to merge Workflow test coverage into nyc's global test coverage.

```ts
after(() => {
  workflowCoverage.mergeIntoGlobalCoverage();
});
```

## Usage with Jest

This package also works with [Jest](https://jestjs.io/) code coverage.
However, this package _only_ works with the default [`coverageProvider` option `'babel'`](https://jestjs.io/docs/configuration#coverageprovider-string).
This package does **not** work with `coverageProvider: 'v8'`.
Complete the following steps to use this package with Jest.

1. `npm install jest @temporalio/nyc-test-coverage`
2. Check your [Jest config](https://jestjs.io/docs/configuration) and make sure the [`coverageProvider` option](https://jestjs.io/docs/configuration#coverageprovider-string) is **not** set to `'v8'`. Set `coverageProvider` to `'babel'`.
3. Instantiate `WorkflowCoverage` from this package, and call `augmentWorkerOptions()` to configure Workflows to gather and export code coverage data:

```ts
import { WorkflowCoverage } from '@temporalio/nyc-test-coverage';

const workflowCoverage = new WorkflowCoverage();

worker = await Worker.create(
  workflowCoverage.augmentWorkerOptions({
    connection: nativeConnection,
    taskQueue,
    workflowsPath: require.resolve('./workflows'),
  })
);
```

4. After your tests are done, call `mergeIntoGlobalCoverage()` to merge your Workflows' code coverage into Jest's global coverage.

```ts
afterAll(() => {
  workflowCoverage.mergeIntoGlobalCoverage();
});
```
