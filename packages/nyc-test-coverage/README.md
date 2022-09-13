# `@temporalio/nyc-test-coverage`

[![NPM](https://img.shields.io/npm/v/@temporalio/nyc-test-coverage?style=for-the-badge)](https://www.npmjs.com/package/@temporalio/nyc-test-coverage)

[Temporal](https://temporal.io)'s [TypeScript SDK](https://docs.temporal.io/typescript/introduction) interceptors and sinks for code coverage with [nyc](https://npmjs.com/package/nyc).

## Getting Started

1. `npm install -D mocha nyc @temporalio/nyc-test-coverage`
2. Use [nyc to manually instrument your Workflow code](https://github.com/istanbuljs/nyc/blob/master/docs/instrument.md), for example `nyc instrument lib lib --in-place`. Make sure you instrument your Workflow code _after_ compiling it with `tsc`.
3. Add this package's sinks and interceptors to your test worker, for example:

```ts
import { WorkflowCoverage } from '@temporalio/nyc-test-coverage';

const workflowCoverage = new WorkflowCoverage();

worker = await Worker.create({
  connection: nativeConnection,
  taskQueue,
  workflowsPath: require.resolve("./workflows"),
  interceptors: {
    workflowModules: [workflowCoverage.interceptorModule]
  },
  sinks: workflowCoverage.sinks,
});
```

4. After your tests are done, call `mergeIntoGlobalCoverage()` to merge your Workflows' code coverage into nyc's global coverage.

```ts
after(() => {
  workflowCoverage.mergeIntoGlobalCoverage();
});
```

For example, the following is a sample npm script that handles instrumenting and running tests.
The following assumes that `npm run build` produces compiled JavaScript in the `lib` directory.

```
{
  "test.coverage": "npm run build && nyc instrument lib lib --in-place && nyc --reporter=lcov --reporter=text-summary mocha lib/*.test.js"
}
```
