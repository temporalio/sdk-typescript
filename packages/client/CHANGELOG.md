# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [0.6.0](https://github.com/temporalio/sdk-node/compare/@temporalio/client@0.5.0...@temporalio/client@0.6.0) (2021-08-29)


* feat!: Use CancelledFailure everywhere for cancellation ([1f6fee4](https://github.com/temporalio/sdk-node/commit/1f6fee4ad1d045adc904079a57c6bea741d8bc38))
* feat!: Port Failure classes from Java SDK ([d1bb4ef](https://github.com/temporalio/sdk-node/commit/d1bb4ef59caa6ea3b0c4fc6108a78e46e4ed2b42))


### Features

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





# [0.5.0](https://github.com/temporalio/sdk-node/compare/@temporalio/client@0.4.3...@temporalio/client@0.5.0) (2021-07-27)


### Bug Fixes

* **workflow:** Allow passing number to ActivityOption timeouts ([#138](https://github.com/temporalio/sdk-node/issues/138)) ([42d9642](https://github.com/temporalio/sdk-node/commit/42d964203a23b9ef3021e8224eaf6808f28b4849))


### Features

* **client:** Implement signalWithStart ([7211342](https://github.com/temporalio/sdk-node/commit/72113425dc187586688b77cc24b4179d52f7320f))
* **workflow:** Implement queries ([9ba6424](https://github.com/temporalio/sdk-node/commit/9ba6424b9cc2c17f7b4125bb2324798327c7073f))
* **workflow:** Implement Workflow cancellation ([f489b3a](https://github.com/temporalio/sdk-node/commit/f489b3a55556de8d1e5d42070f97f056767c5ff4))
* Add opentelemetry interceptors package and sample ([5101e67](https://github.com/temporalio/sdk-node/commit/5101e67273cd4fdb92d2e6696e836999d9596db1))





## [0.4.3](https://github.com/temporalio/sdk-node/compare/@temporalio/client@0.4.2...@temporalio/client@0.4.3) (2021-06-25)

**Note:** Version bump only for package @temporalio/client





## [0.4.2](https://github.com/temporalio/sdk-node/compare/@temporalio/client@0.4.1...@temporalio/client@0.4.2) (2021-06-18)

**Note:** Version bump only for package @temporalio/client





## [0.4.1](https://github.com/temporalio/sdk-node/compare/@temporalio/client@0.4.0...@temporalio/client@0.4.1) (2021-06-18)

**Note:** Version bump only for package @temporalio/client





# [0.4.0](https://github.com/temporalio/sdk-node/compare/@temporalio/client@0.3.0...@temporalio/client@0.4.0) (2021-06-16)


### Features

* **client:** Implement Connection interceptors ([b8795e4](https://github.com/temporalio/sdk-node/commit/b8795e49172b8d127807f00d569d40ce69ffba9d))





# [0.3.0](https://github.com/temporalio/sdk-node/compare/@temporalio/client@0.2.0...@temporalio/client@0.3.0) (2021-05-17)


### Bug Fixes

* **client:** Fix Connection.untilReady() not actually waiting ([e98d642](https://github.com/temporalio/sdk-node/commit/e98d64207467d590deab7980e917becb8b3d0390))
* **client:** Fix WorkflowClient error with non-default namespace ([d60a8ed](https://github.com/temporalio/sdk-node/commit/d60a8ed19b1964379d2a76ff687b7330ffb1b3e7))


### Features

* **client:** Duplicate ConnectionOptions.tls from Worker ServerOptions ([1770aed](https://github.com/temporalio/sdk-node/commit/1770aed69c598eed48f2a1bc4b9421ecea41c0d7))
