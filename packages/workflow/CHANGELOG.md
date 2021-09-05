# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [0.7.0](https://github.com/temporalio/sdk-node/compare/@temporalio/workflow@0.6.0...@temporalio/workflow@0.7.0) (2021-08-31)


* feat!: Revise Activity setup and registration, use single tsconfig in project skeleton ([b97dd21](https://github.com/temporalio/sdk-node/commit/b97dd21aff3f5d1e5beb1fc6f4e71a04d761ac02))


### Features

* Use eval-source-map devtool for improved stack traces ([c7d2361](https://github.com/temporalio/sdk-node/commit/c7d2361efb5cfaa626b5f2cd151d6c893ee1c248))


### BREAKING CHANGES

* `@activities` import does not work any more.
Activities registration is either done automatically with the `workDir`
option or by providing `activities` to `WorkerOptions`.





# [0.6.0](https://github.com/temporalio/sdk-node/compare/@temporalio/workflow@0.5.0...@temporalio/workflow@0.6.0) (2021-08-29)


### Bug Fixes

* Don't send child signal before WF started ([cbefd42](https://github.com/temporalio/sdk-node/commit/cbefd4215d917c12286a57ceb2ccd951e07d799e))
* **workflow:** Use sequence number for correlation IDs ([c527d57](https://github.com/temporalio/sdk-node/commit/c527d5765018343a6aab4e57cd42da31ef55a279))


* feat(worker)!: Move maxCachedWorkflows to WorkerOptions ([913a78b](https://github.com/temporalio/sdk-node/commit/913a78b1c77b50cce27544ef078a2c3d61a2be6e))
* feat!: Use CancelledFailure everywhere for cancellation ([1f6fee4](https://github.com/temporalio/sdk-node/commit/1f6fee4ad1d045adc904079a57c6bea741d8bc38))
* feat!: Port Failure classes from Java SDK ([d1bb4ef](https://github.com/temporalio/sdk-node/commit/d1bb4ef59caa6ea3b0c4fc6108a78e46e4ed2b42))


### Features

* `patched` api ([91b5312](https://github.com/temporalio/sdk-node/commit/91b5312f550f6512dcaa5a07374abe34b622bab1))
* Complete child / external workflow implementation ([1825a03](https://github.com/temporalio/sdk-node/commit/1825a0335130ea928de403652432c95444fb635e))
* Implement child workflows start and complete ([ca6f4ee](https://github.com/temporalio/sdk-node/commit/ca6f4ee0868081e0c115ff05bda6a5e47c13493d))
* **proto:** Split generated protos into coresdk and temporal ([10a4fb2](https://github.com/temporalio/sdk-node/commit/10a4fb2e16736bd05e31b560a77f861b9a574aa0))


### BREAKING CHANGES

* Core.install and Worker.create options interfaces
were restructured.
* use `isCancellation(err)` instead of catching `CancelledError` for
handling cancellations, cancelled activities and child workflows now throw
`ActivityFailure` and `ChildWorkflowFailure` respectively with cause set
to `CancelledFailure`.
* Activities functions now throw `ActivityFailure` in Workflow.
WorkflowClient and WorkflowStub now chain the Workflow error as `cause`
of `WorkflowExecutionFailedError` instead of setting the `message`
property.





# [0.5.0](https://github.com/temporalio/sdk-node/compare/@temporalio/workflow@0.4.0...@temporalio/workflow@0.5.0) (2021-07-27)


### Bug Fixes

* **workflow:** Allow passing number to ActivityOption timeouts ([#138](https://github.com/temporalio/sdk-node/issues/138)) ([42d9642](https://github.com/temporalio/sdk-node/commit/42d964203a23b9ef3021e8224eaf6808f28b4849))
* Throw DeterminismViolationError when a query handler returns a Promise ([0febe2f](https://github.com/temporalio/sdk-node/commit/0febe2f4177c460866ee7bb0c1e1b4dd43e025d8))


### Features

* **workflow:** Expose ActivityCancellationType ([45cc42d](https://github.com/temporalio/sdk-node/commit/45cc42d332d9e45a2587d366a1db123c7c6aa9d0))
* **workflow:** Implement continueAsNew ([d743cdf](https://github.com/temporalio/sdk-node/commit/d743cdfe49ecb6511c8cefbfaf6fd2870e5de670))
* **workflow:** Implement queries ([9ba6424](https://github.com/temporalio/sdk-node/commit/9ba6424b9cc2c17f7b4125bb2324798327c7073f))
* **workflow:** Implement Workflow cancellation ([f489b3a](https://github.com/temporalio/sdk-node/commit/f489b3a55556de8d1e5d42070f97f056767c5ff4))





# [0.4.0](https://github.com/temporalio/sdk-node/compare/@temporalio/workflow@0.3.2...@temporalio/workflow@0.4.0) (2021-06-25)


### Features

* **workflow:** Lazily load user code into Workflow isolate ([990cc1f](https://github.com/temporalio/sdk-node/commit/990cc1fb4347bb8e102c1d8e1b628d5766144a5d))
* Add Workflow AsyncLocalStorage ([5ce2233](https://github.com/temporalio/sdk-node/commit/5ce2233fd7d5a19e6b33e2f30c535fba44fa8ed3))





## [0.3.2](https://github.com/temporalio/sdk-node/compare/@temporalio/workflow@0.3.1...@temporalio/workflow@0.3.2) (2021-06-18)

**Note:** Version bump only for package @temporalio/workflow





## [0.3.1](https://github.com/temporalio/sdk-node/compare/@temporalio/workflow@0.3.0...@temporalio/workflow@0.3.1) (2021-06-18)

**Note:** Version bump only for package @temporalio/workflow





# [0.3.0](https://github.com/temporalio/sdk-node/compare/@temporalio/workflow@0.2.1...@temporalio/workflow@0.3.0) (2021-06-16)


### Bug Fixes

* **workflow:** Fix scope association after promise is resolved ([ee288b4](https://github.com/temporalio/sdk-node/commit/ee288b40ba1a45f7c94b11a360e3ac7a341515b2))
* **workflow:** Workflow overrides do not take effect before starting a Workflow ([d59051c](https://github.com/temporalio/sdk-node/commit/d59051c732e961100ba75fdc431b742a489cfebb))


### Features

* Implement Workflow and Activity interceptors ([8da2300](https://github.com/temporalio/sdk-node/commit/8da230004031d1759b94b7bdb6a7b797e133a4a9))
* Support injecting external dependencies into the Workflow isolate ([ac163b3](https://github.com/temporalio/sdk-node/commit/ac163b3ea48487fe3d31a17e0dee0530e322efee))





## [0.2.1](https://github.com/temporalio/sdk-node/compare/@temporalio/workflow@0.2.0...@temporalio/workflow@0.2.1) (2021-05-17)

**Note:** Version bump only for package @temporalio/workflow
