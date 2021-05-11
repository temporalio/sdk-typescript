## 0.2.0 (May 11, 2021)

#### temporalio `0.2.0`

- [#86](https://github.com/temporalio/sdk-node/pulls/86) Drop support for node 12 in favor of node 16 ([@bergundy](https://github.com/bergundy))

#### @temporalio/worker `0.2.0`

- [#86](https://github.com/temporalio/sdk-node/pulls/86) :boom: Use Webpack to bundle Workflow code and load it into a startup snapshot ([@bergundy](https://github.com/bergundy))
- [#86](https://github.com/temporalio/sdk-node/pulls/86) Increase default concurrent Workflow activation limit to 100 ([@bergundy](https://github.com/bergundy))

#### @temporalio/create `0.2.0`

- [#91](https://github.com/temporalio/sdk-node/pulls/91) Strip snipsync comments from generated code ([@bergundy](https://github.com/bergundy))
- [#86](https://github.com/temporalio/sdk-node/pulls/86) Compile Workflow code to commonjs instead of ES modules ([@bergundy](https://github.com/bergundy))
- [#86](https://github.com/temporalio/sdk-node/pulls/86) Get rid of broken Worker `@activities` and `@workflows` path aliases ([@bergundy](https://github.com/bergundy))

#### @temporalio/client `0.2.0`

- [#90](https://github.com/temporalio/sdk-node/pulls/90) Use native `grpc` package instead of `@grpc/grpc-js` ([@bergundy](https://github.com/bergundy))
- [#90](https://github.com/temporalio/sdk-node/pulls/90) :boom: Unify client options interfaces ([@bergundy](https://github.com/bergundy))
