# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

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
