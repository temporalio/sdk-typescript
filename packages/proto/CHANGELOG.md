# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [0.3.3](https://github.com/temporalio/sdk-node/compare/@temporalio/proto@0.3.2...@temporalio/proto@0.3.3) (2021-09-23)

**Note:** Version bump only for package @temporalio/proto





## [0.3.2](https://github.com/temporalio/sdk-node/compare/@temporalio/proto@0.3.1...@temporalio/proto@0.3.2) (2021-09-15)

**Note:** Version bump only for package @temporalio/proto





## [0.3.1](https://github.com/temporalio/sdk-node/compare/@temporalio/proto@0.3.0...@temporalio/proto@0.3.1) (2021-08-31)

**Note:** Version bump only for package @temporalio/proto





# [0.3.0](https://github.com/temporalio/sdk-node/compare/@temporalio/proto@0.2.4...@temporalio/proto@0.3.0) (2021-08-29)


* feat!: Port Failure classes from Java SDK ([d1bb4ef](https://github.com/temporalio/sdk-node/commit/d1bb4ef59caa6ea3b0c4fc6108a78e46e4ed2b42))


### Features

* **proto:** Split generated protos into coresdk and temporal ([10a4fb2](https://github.com/temporalio/sdk-node/commit/10a4fb2e16736bd05e31b560a77f861b9a574aa0))


### BREAKING CHANGES

* Activities functions now throw `ActivityFailure` in Workflow.
WorkflowClient and WorkflowStub now chain the Workflow error as `cause`
of `WorkflowExecutionFailedError` instead of setting the `message`
property.





## [0.2.4](https://github.com/temporalio/sdk-node/compare/@temporalio/proto@0.2.3...@temporalio/proto@0.2.4) (2021-07-27)

**Note:** Version bump only for package @temporalio/proto





## [0.2.3](https://github.com/temporalio/sdk-node/compare/@temporalio/proto@0.2.2...@temporalio/proto@0.2.3) (2021-06-25)

**Note:** Version bump only for package @temporalio/proto





## [0.2.2](https://github.com/temporalio/sdk-node/compare/@temporalio/proto@0.2.1...@temporalio/proto@0.2.2) (2021-06-18)


### Bug Fixes

* Add core-bridge package to make lerna publish the dependant proto package ([7115078](https://github.com/temporalio/sdk-node/commit/7115078ba65d6bf1d9cf7eaae238a25f047da194))





## [0.2.1](https://github.com/temporalio/sdk-node/compare/@temporalio/proto@0.2.0...@temporalio/proto@0.2.1) (2021-05-17)

**Note:** Version bump only for package @temporalio/proto
