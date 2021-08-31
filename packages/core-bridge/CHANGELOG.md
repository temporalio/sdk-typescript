# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [0.3.1](https://github.com/temporalio/sdk-node/compare/@temporalio/core-bridge@0.3.0...@temporalio/core-bridge@0.3.1) (2021-08-31)

**Note:** Version bump only for package @temporalio/core-bridge





# [0.3.0](https://github.com/temporalio/sdk-node/compare/@temporalio/core-bridge@0.2.0...@temporalio/core-bridge@0.3.0) (2021-08-29)


### Bug Fixes

* **worker:** Adapt worker to sdk-core shutdown sequence ([8fc981b](https://github.com/temporalio/sdk-node/commit/8fc981bb3d5bb14d0f082d2ef1b282b66d97fe10))
* **workflow:** Use sequence number for correlation IDs ([c527d57](https://github.com/temporalio/sdk-node/commit/c527d5765018343a6aab4e57cd42da31ef55a279))


* feat(worker)!: Move maxCachedWorkflows to WorkerOptions ([913a78b](https://github.com/temporalio/sdk-node/commit/913a78b1c77b50cce27544ef078a2c3d61a2be6e))
* feat!: Use CancelledFailure everywhere for cancellation ([1f6fee4](https://github.com/temporalio/sdk-node/commit/1f6fee4ad1d045adc904079a57c6bea741d8bc38))
* feat!: Port Failure classes from Java SDK ([d1bb4ef](https://github.com/temporalio/sdk-node/commit/d1bb4ef59caa6ea3b0c4fc6108a78e46e4ed2b42))


### Features

* Add gRPC retries for Worker->server requests ([8db7c67](https://github.com/temporalio/sdk-node/commit/8db7c673d2e9a4f05afb2a887b603172c8ad3e33))
* Complete child / external workflow implementation ([1825a03](https://github.com/temporalio/sdk-node/commit/1825a0335130ea928de403652432c95444fb635e))
* Implement child workflows start and complete ([ca6f4ee](https://github.com/temporalio/sdk-node/commit/ca6f4ee0868081e0c115ff05bda6a5e47c13493d))


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





# [0.2.0](https://github.com/temporalio/sdk-node/compare/@temporalio/core-bridge@0.1.0...@temporalio/core-bridge@0.2.0) (2021-07-27)


### Features

* **core:** Use unbounded channel for the bridge loop ([1a016a6](https://github.com/temporalio/sdk-node/commit/1a016a6c5af5d19b799f693ba0e9184871253350))
* **workflow:** Implement continueAsNew ([d743cdf](https://github.com/temporalio/sdk-node/commit/d743cdfe49ecb6511c8cefbfaf6fd2870e5de670))
* **workflow:** Implement queries ([9ba6424](https://github.com/temporalio/sdk-node/commit/9ba6424b9cc2c17f7b4125bb2324798327c7073f))
* **workflow:** Implement Workflow cancellation ([f489b3a](https://github.com/temporalio/sdk-node/commit/f489b3a55556de8d1e5d42070f97f056767c5ff4))





# [0.1.0](https://github.com/temporalio/sdk-node/compare/@temporalio/core-bridge@0.0.1...@temporalio/core-bridge@0.1.0) (2021-06-25)


### Bug Fixes

* Fix cross compilation of rust code ([3f7e0ee](https://github.com/temporalio/sdk-node/commit/3f7e0ee3820996978b172e603b62e8aafa78ed1c))


### Features

* **core:** Update core to support sticky execution ([78730a4](https://github.com/temporalio/sdk-node/commit/78730a4d1f9e631429de5073ba4e7865bf22d596))





## 0.0.1 (2021-06-18)


### Bug Fixes

* Add core-bridge package to make lerna publish the dependant proto package ([7115078](https://github.com/temporalio/sdk-node/commit/7115078ba65d6bf1d9cf7eaae238a25f047da194))
