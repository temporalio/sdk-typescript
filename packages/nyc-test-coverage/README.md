# `@temporalio/nyc-test-coverage`

[![NPM](https://img.shields.io/npm/v/@temporalio/nyc-test-coverage?style=for-the-badge)](https://www.npmjs.com/package/@temporalio/nyc-test-coverage)

[Temporal](https://temporal.io)'s [TypeScript SDK](https://docs.temporal.io/typescript/introduction) interceptors and sinks for code coverage with [nyc](https://npmjs.com/package/nyc).

## Getting Started

1. `npm install mocha nyc`
2. Use nyc to manually instrument your Workflow code, for example `nyc instrument lib lib --in-place`. Make sure you instrument your Workflow code _after_ compiling it with `tsc`.
3. Add this package's sinks and interceptors to your test worker, for example:

```ts
import { CoverageSinks } from '@temporalio/nyc-test-coverage';

const coverageSinks = new CoverageSinks();

worker = await Worker.create({
  connection: nativeConnection,
  taskQueue,
  workflowsPath: require.resolve("./workflows"),
  activities: undefined,
  interceptors: {
    workflowModules: [require.resolve("@temporalio/nyc-test-coverage/lib/interceptors")]
  },
  sinks: coverageSinks.sinks,
});
```

4. After your tests are done, call `mergeIntoGlobalCoverage()` to merge your Workflows' code coverage into nyc's global coverage.

```ts
after(() => {
  coverageSinks.mergeIntoGlobalCoverage();
});
```

For example, the following is a sample npm script that handles instrumenting and running tests.

```
{
  "test.coverage": "npm run build && nyc instrument lib lib --in-place && nyc --reporter=lcov --reporter=text-summary mocha lib/*.test.js"
}
```