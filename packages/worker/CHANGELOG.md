# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [0.7.0](https://github.com/temporalio/sdk-node/compare/@temporalio/worker@0.6.0...@temporalio/worker@0.7.0) (2021-08-29)


### Bug Fixes

* Destroy isolates and scripts in tests and when Worker completes ([df31ade](https://github.com/temporalio/sdk-node/commit/df31adeeb7631ec128f23da9480d2fd21a7aa9c2))
* **worker:** Acknowledge eviction only activations ([250640a](https://github.com/temporalio/sdk-node/commit/250640a9a2028dca2a298408ffd4ec21fd2210dd))
* **worker:** Adapt worker to sdk-core shutdown sequence ([8fc981b](https://github.com/temporalio/sdk-node/commit/8fc981bb3d5bb14d0f082d2ef1b282b66d97fe10))
* **worker:** Allow creating a Worker with no workflows ([66859a9](https://github.com/temporalio/sdk-node/commit/66859a9e76a8921b79cb3b3d031fa8bfbcf7adfb))
* **worker:** Avoid throwing error when there's no activities directory ([bd89e50](https://github.com/temporalio/sdk-node/commit/bd89e5002f1258145bc039ec439a63b453e7d53d))
* **worker:** Fix Worker could be in DRAINING state when asked to poll ([fb5825e](https://github.com/temporalio/sdk-node/commit/fb5825e1dd027244b6f86bd040a72886d5d07569))


* feat(worker)!: Move maxCachedWorkflows to WorkerOptions ([913a78b](https://github.com/temporalio/sdk-node/commit/913a78b1c77b50cce27544ef078a2c3d61a2be6e))
* feat!: Use CancelledFailure everywhere for cancellation ([1f6fee4](https://github.com/temporalio/sdk-node/commit/1f6fee4ad1d045adc904079a57c6bea741d8bc38))
* feat!: Port Failure classes from Java SDK ([d1bb4ef](https://github.com/temporalio/sdk-node/commit/d1bb4ef59caa6ea3b0c4fc6108a78e46e4ed2b42))


### Features

* `patched` api ([91b5312](https://github.com/temporalio/sdk-node/commit/91b5312f550f6512dcaa5a07374abe34b622bab1))
* **proto:** Split generated protos into coresdk and temporal ([10a4fb2](https://github.com/temporalio/sdk-node/commit/10a4fb2e16736bd05e31b560a77f861b9a574aa0))
* Use ivm.Script instead of snapshots ([961bd7b](https://github.com/temporalio/sdk-node/commit/961bd7bf9f2ed1b9937973c3a3e67abe7a615654))


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





# [0.6.0](https://github.com/temporalio/sdk-node/compare/@temporalio/worker@0.5.0...@temporalio/worker@0.6.0) (2021-07-27)


### Bug Fixes

* **worker:** Fix ActivityInfo.heartbeatDetails was a Promise ([6b0d87c](https://github.com/temporalio/sdk-node/commit/6b0d87cd5edad7b14f91c5f618bcc8a8f426d596))
* **worker:** Fix isolate reference leak ([9e59f7a](https://github.com/temporalio/sdk-node/commit/9e59f7a5e2ebd9a50cfada24d19a1ed5eeb389d6))
* **workflow:** Allow passing number to ActivityOption timeouts ([#138](https://github.com/temporalio/sdk-node/issues/138)) ([42d9642](https://github.com/temporalio/sdk-node/commit/42d964203a23b9ef3021e8224eaf6808f28b4849))
* Explicitly set isolate devtool to cheap-source-map ([5a4388b](https://github.com/temporalio/sdk-node/commit/5a4388bf69f20ca4dfed9b8b35573d9725c1a86f))


### Features

* **worker:** Use a pool of isolates ([233902f](https://github.com/temporalio/sdk-node/commit/233902f9a72109d3ee35bbe16c9b0a46067480a5))
* Add opentelemetry interceptors package and sample ([5101e67](https://github.com/temporalio/sdk-node/commit/5101e67273cd4fdb92d2e6696e836999d9596db1))





# [0.5.0](https://github.com/temporalio/sdk-node/compare/@temporalio/worker@0.4.2...@temporalio/worker@0.5.0) (2021-06-25)


### Bug Fixes

* **workflow:** Pass max isolate memory limit option to isolate ([8d6d3d2](https://github.com/temporalio/sdk-node/commit/8d6d3d204ca4a6734dcbe84248e47e074debfa49))
* **workflow:** Report filename when reporting workflow not found ([#121](https://github.com/temporalio/sdk-node/issues/121)) ([f6af189](https://github.com/temporalio/sdk-node/commit/f6af189b2f38b1d3989b9982b6cb1a47204c3dec))
* **Workflow:** Avoid bubbling up "Unknown encoding" error to user ([#133](https://github.com/temporalio/sdk-node/issues/133)) ([0a831f7](https://github.com/temporalio/sdk-node/commit/0a831f77d6c0ae464639e97ac3f25a3d28069502))


### Features

* **core:** Update core to support sticky execution ([78730a4](https://github.com/temporalio/sdk-node/commit/78730a4d1f9e631429de5073ba4e7865bf22d596))
* **workflow:** Lazily load user code into Workflow isolate ([990cc1f](https://github.com/temporalio/sdk-node/commit/990cc1fb4347bb8e102c1d8e1b628d5766144a5d))





## [0.4.2](https://github.com/temporalio/sdk-node/compare/@temporalio/worker@0.4.1...@temporalio/worker@0.4.2) (2021-06-18)


### Bug Fixes

* Add core-bridge package to make lerna publish the dependant proto package ([7115078](https://github.com/temporalio/sdk-node/commit/7115078ba65d6bf1d9cf7eaae238a25f047da194))





## [0.4.1](https://github.com/temporalio/sdk-node/compare/@temporalio/worker@0.4.0...@temporalio/worker@0.4.1) (2021-06-18)

**Note:** Version bump only for package @temporalio/worker





# [0.4.0](https://github.com/temporalio/sdk-node/compare/@temporalio/worker@0.3.0...@temporalio/worker@0.4.0) (2021-06-16)


### Bug Fixes

* **worker:** Avoid error caused by non-existent activities directory ([ad88671](https://github.com/temporalio/sdk-node/commit/ad8867189d134ef31b03899e35db0b4610215d76))
* **worker:** Make isolate error message suggest a fix ([d7d4b66](https://github.com/temporalio/sdk-node/commit/d7d4b660a0fbe393136547fb415bda928fc7f36e))
* **workflow:** Workflow overrides do not take effect before starting a Workflow ([d59051c](https://github.com/temporalio/sdk-node/commit/d59051c732e961100ba75fdc431b742a489cfebb))


### Features

* Implement Workflow and Activity interceptors ([8da2300](https://github.com/temporalio/sdk-node/commit/8da230004031d1759b94b7bdb6a7b797e133a4a9))
* Support injecting external dependencies into the Workflow isolate ([ac163b3](https://github.com/temporalio/sdk-node/commit/ac163b3ea48487fe3d31a17e0dee0530e322efee))





# [0.3.0](https://github.com/temporalio/sdk-node/compare/@temporalio/worker@0.2.0...@temporalio/worker@0.3.0) (2021-05-17)


### Bug Fixes

* **core:** Gracefully exit bridge loop when Worker has been dropped ([111908b](https://github.com/temporalio/sdk-node/commit/111908b5cfae4b49046081e1b60e364fd6ec0230))
* **worker:** Fix panic while getting Worker TLS options ([3ea3c00](https://github.com/temporalio/sdk-node/commit/3ea3c002ee22bab458f35a701add95f60fce36d9))


### Features

* **client:** Duplicate ConnectionOptions.tls from Worker ServerOptions ([1770aed](https://github.com/temporalio/sdk-node/commit/1770aed69c598eed48f2a1bc4b9421ecea41c0d7))
* **core:** Update core to support background heartbeats and TLS connection ([082f994](https://github.com/temporalio/sdk-node/commit/082f9949ddef3a1ec2271eacb3fc2a9cb2a1cc6d))
* **worker:** Add TLS config to Worker ServerOptions ([5461029](https://github.com/temporalio/sdk-node/commit/5461029c07cd91680756671c4a6fd1e32d7888f6))


### BREAKING CHANGES

* **core:** `WorkerOptions.maxConcurrentActivityExecutions` was renamed `maxConcurrentActivityTaskExecutions`.
