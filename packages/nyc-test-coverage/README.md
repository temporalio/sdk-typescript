# `@temporalio/nyc-test-coverage`

[![NPM](https://img.shields.io/npm/v/@temporalio/nyc-test-coverage?style=for-the-badge)](https://www.npmjs.com/package/@temporalio/nyc-test-coverage)

[Temporal](https://temporal.io)'s [TypeScript SDK](https://docs.temporal.io/typescript/introduction) integration for Workflow code coverage with [nyc](https://npmjs.com/package/nyc) and similar tools.

## Getting Started

1. `npm install mocha nyc`
2. Instantiate `WorkflowCoverage` from this package, and call `augmentWorkerOptions()` to configure Workflows to gather and export code coverage data:

```ts
import { WorkflowCoverage } from '@temporalio/nyc-test-coverage';

const workflowCoverage = new WorkflowCoverage();

worker = await Worker.create(workflowCoverage.augmentWorkerOptions({
  connection: nativeConnection,
  taskQueue,
  workflowsPath: require.resolve("./workflows"),
}));
```

3. After your tests are done, call `mergeIntoGlobalCoverage()` to merge your Workflows' code coverage into nyc's global coverage.

```ts
after(() => {
  workflowCoverage.mergeIntoGlobalCoverage();
});
```

## Usage with Jest

This package also works with [Jest](https://jestjs.io/).
However, this package _only_ works with the default [`coverageProvider` option `'babel'`](https://jestjs.io/docs/configuration#coverageprovider-string).
This package does **not** work with `coverageProvider: 'v8'`.
