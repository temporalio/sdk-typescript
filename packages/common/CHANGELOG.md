# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [0.3.0](https://github.com/temporalio/sdk-node/compare/@temporalio/common@0.2.0...@temporalio/common@0.3.0) (2021-09-15)


* feat!: Use Object instead of Map for interceptor headers ([80db27d](https://github.com/temporalio/sdk-node/commit/80db27d62bad78a71352cdc5db2b9ca49b9d1062))
* feat(workflow)!: Remove Local and Remote ActivityOptions ([d29844d](https://github.com/temporalio/sdk-node/commit/d29844d992e61354297ca660d0b103e39001f519))
* feat(workflow)!: Revise Workflow API ([3467bd7](https://github.com/temporalio/sdk-node/commit/3467bd798f5e6866412be67c0b0e645e1d66dd7f))


### BREAKING CHANGES

* Interceptors now use an Object for representing headers
instead of a Map

With this change it's easier to chain interceptors without mutating the
input.
* `ActivityOptions` no longer take a `type` attribute.
`LocalActivityOptions` and `RemoteActivityOptions` interfaces have been
removed.
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





# [0.2.0](https://github.com/temporalio/sdk-node/compare/@temporalio/common@0.1.0...@temporalio/common@0.2.0) (2021-08-31)


* feat!: Revise Activity setup and registration, use single tsconfig in project skeleton ([b97dd21](https://github.com/temporalio/sdk-node/commit/b97dd21aff3f5d1e5beb1fc6f4e71a04d761ac02))


### Features

* Use eval-source-map devtool for improved stack traces ([c7d2361](https://github.com/temporalio/sdk-node/commit/c7d2361efb5cfaa626b5f2cd151d6c893ee1c248))


### BREAKING CHANGES

* `@activities` import does not work any more.
Activities registration is either done automatically with the `workDir`
option or by providing `activities` to `WorkerOptions`.





# 0.1.0 (2021-08-29)


### Bug Fixes

* **workflow:** Use sequence number for correlation IDs ([c527d57](https://github.com/temporalio/sdk-node/commit/c527d5765018343a6aab4e57cd42da31ef55a279))


* feat!: Use CancelledFailure everywhere for cancellation ([1f6fee4](https://github.com/temporalio/sdk-node/commit/1f6fee4ad1d045adc904079a57c6bea741d8bc38))
* feat!: Port Failure classes from Java SDK ([d1bb4ef](https://github.com/temporalio/sdk-node/commit/d1bb4ef59caa6ea3b0c4fc6108a78e46e4ed2b42))


### Features

* Add sync DataConverter interface for workflow code ([26c695d](https://github.com/temporalio/sdk-node/commit/26c695d7a9ea93e62ade85ab131efa96e90553a1))
* Complete child / external workflow implementation ([1825a03](https://github.com/temporalio/sdk-node/commit/1825a0335130ea928de403652432c95444fb635e))
* Implement child workflows start and complete ([ca6f4ee](https://github.com/temporalio/sdk-node/commit/ca6f4ee0868081e0c115ff05bda6a5e47c13493d))
* **proto:** Split generated protos into coresdk and temporal ([10a4fb2](https://github.com/temporalio/sdk-node/commit/10a4fb2e16736bd05e31b560a77f861b9a574aa0))


### BREAKING CHANGES

* use `isCancellation(err)` instead of catching `CancelledError` for
handling cancellations, cancelled activities and child workflows now throw
`ActivityFailure` and `ChildWorkflowFailure` respectively with cause set
to `CancelledFailure`.
* Activities functions now throw `ActivityFailure` in Workflow.
WorkflowClient and WorkflowStub now chain the Workflow error as `cause`
of `WorkflowExecutionFailedError` instead of setting the `message`
property.
