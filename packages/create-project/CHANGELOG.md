# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [0.5.0](https://github.com/temporalio/sdk-node/compare/@temporalio/create@0.4.0...@temporalio/create@0.5.0) (2021-09-15)


### Bug Fixes

* Fix permissions for packages/create-project/lib/index.js ([da369db](https://github.com/temporalio/sdk-node/commit/da369db65150e766e35a7af5b9f79b977de140cb))


* feat(workflow)!: Flatten Context into `@temporalio/workflow` ([0751479](https://github.com/temporalio/sdk-node/commit/07514796df723328f870fe0d64702f928092608c))
* feat(workflow)!: Revise Workflow API ([3467bd7](https://github.com/temporalio/sdk-node/commit/3467bd798f5e6866412be67c0b0e645e1d66dd7f))


### BREAKING CHANGES

* `Context` is no longer exported, methods and attributes
have been flattened into `@temporalio/workflow`.
- `Context.info` -> `workflowInfo`
- `Context.child` -> `childWorkflow`
- `Context.external` -> `externalWorkflow`
- `Context.cancelled` -> `ROOT_SCOPE.consideredCancelled`
- `Context.continueAsNew` -> `continueAsNew`
- `Context.makeContinueAsNewFunc` -> `makeContinueAsNewFunc`
* Workflow registration and invocation has been changed
- `main` has been renamed `execute`
- Workflow arguments moved from `execute` method to the Workflow factory
  function (see below)
- Workflows are now defined as named functions
  Old:
  ```ts
  // workflows/myWorkflow.ts
  export const workflow = { async main(...args) {}, /* signals, queries */ };
  ```
  New:
  ```ts
  // workflows/index.ts
  export const myWorkflow = (...args) => ({ async execute() {}, /* signals, queries */ });
  ```
- Workflow Interceptors are now instantiated via a factory function
  Old:
  ```ts
  export const interceptors = { /* ... */ };
  ```
  New:
  ```ts
  export const interceptors = () => ({ /* ... */ });
  ```
- Workflow stubs can be constructed from a registered Workflow function
  Old:
  ```ts
  const stub = client.stub<MyWorkflowInterface>('my-workflow', opts);
  ```
  New:
  ```ts
  import { myWorkflow } from './workflows';
  const stub = client.stub(myWorkflow, opts);
  ```





# [0.4.0](https://github.com/temporalio/sdk-node/compare/@temporalio/create@0.3.4...@temporalio/create@0.4.0) (2021-08-31)


* feat!: Revise Activity setup and registration, use single tsconfig in project skeleton ([b97dd21](https://github.com/temporalio/sdk-node/commit/b97dd21aff3f5d1e5beb1fc6f4e71a04d761ac02))


### Features

* Support bundling TS into isolate ([ca9806e](https://github.com/temporalio/sdk-node/commit/ca9806e3c7ebb33447f3413bf9a997c730f7f9ac))


### BREAKING CHANGES

* `@activities` import does not work any more.
Activities registration is either done automatically with the `workDir`
option or by providing `activities` to `WorkerOptions`.





## [0.3.4](https://github.com/temporalio/sdk-node/compare/@temporalio/create@0.3.3...@temporalio/create@0.3.4) (2021-08-29)

**Note:** Version bump only for package @temporalio/create





## [0.3.3](https://github.com/temporalio/sdk-node/compare/@temporalio/create@0.3.2...@temporalio/create@0.3.3) (2021-07-27)

**Note:** Version bump only for package @temporalio/create





## [0.3.2](https://github.com/temporalio/sdk-node/compare/@temporalio/create@0.3.1...@temporalio/create@0.3.2) (2021-06-25)

**Note:** Version bump only for package @temporalio/create





## [0.3.1](https://github.com/temporalio/sdk-node/compare/@temporalio/create@0.3.0...@temporalio/create@0.3.1) (2021-06-16)


### Bug Fixes

* **workflow:** Workflow overrides do not take effect before starting a Workflow ([d59051c](https://github.com/temporalio/sdk-node/commit/d59051c732e961100ba75fdc431b742a489cfebb))





# [0.3.0](https://github.com/temporalio/sdk-node/compare/@temporalio/create@0.2.0...@temporalio/create@0.3.0) (2021-05-17)


### Features

* **client:** Duplicate ConnectionOptions.tls from Worker ServerOptions ([1770aed](https://github.com/temporalio/sdk-node/commit/1770aed69c598eed48f2a1bc4b9421ecea41c0d7))
* **worker:** Add TLS config to Worker ServerOptions ([5461029](https://github.com/temporalio/sdk-node/commit/5461029c07cd91680756671c4a6fd1e32d7888f6))
