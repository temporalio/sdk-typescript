# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [0.4.2](https://github.com/temporalio/sdk-node/compare/temporalio@0.4.1...temporalio@0.4.2) (2021-09-15)


### Bug Fixes

* Add all dependencies to meta, interceptors and test packages ([8b490a7](https://github.com/temporalio/sdk-node/commit/8b490a725f51b9f1222248457fe3b7c2546e0921))





## [0.4.1](https://github.com/temporalio/sdk-node/compare/temporalio@0.4.0...temporalio@0.4.1) (2021-08-31)

**Note:** Version bump only for package temporalio





# [0.4.0](https://github.com/temporalio/sdk-node/compare/temporalio@0.3.0...temporalio@0.4.0) (2021-08-29)


* feat!: Use CancelledFailure everywhere for cancellation ([1f6fee4](https://github.com/temporalio/sdk-node/commit/1f6fee4ad1d045adc904079a57c6bea741d8bc38))


### BREAKING CHANGES

* use `isCancellation(err)` instead of catching `CancelledError` for
handling cancellations, cancelled activities and child workflows now throw
`ActivityFailure` and `ChildWorkflowFailure` respectively with cause set
to `CancelledFailure`.





# [0.3.0](https://github.com/temporalio/sdk-node/compare/temporalio@0.2.5...temporalio@0.3.0) (2021-07-27)


### Features

* **workflow:** Implement continueAsNew ([d743cdf](https://github.com/temporalio/sdk-node/commit/d743cdfe49ecb6511c8cefbfaf6fd2870e5de670))
* **workflow:** Implement Workflow cancellation ([f489b3a](https://github.com/temporalio/sdk-node/commit/f489b3a55556de8d1e5d42070f97f056767c5ff4))





## [0.2.5](https://github.com/temporalio/sdk-node/compare/temporalio@0.2.4...temporalio@0.2.5) (2021-06-25)

**Note:** Version bump only for package temporalio





## [0.2.4](https://github.com/temporalio/sdk-node/compare/temporalio@0.2.3...temporalio@0.2.4) (2021-06-18)

**Note:** Version bump only for package temporalio





## [0.2.3](https://github.com/temporalio/sdk-node/compare/temporalio@0.2.2...temporalio@0.2.3) (2021-06-18)

**Note:** Version bump only for package temporalio





## [0.2.2](https://github.com/temporalio/sdk-node/compare/temporalio@0.2.1...temporalio@0.2.2) (2021-06-16)

**Note:** Version bump only for package temporalio





## [0.2.1](https://github.com/temporalio/sdk-node/compare/temporalio@0.2.0...temporalio@0.2.1) (2021-05-17)

**Note:** Version bump only for package temporalio
