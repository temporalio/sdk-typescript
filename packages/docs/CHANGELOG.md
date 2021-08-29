# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [0.2.0](https://github.com/temporalio/sdk-node/compare/@temporalio/docs@0.1.3...@temporalio/docs@0.2.0) (2021-08-29)


* feat!: Use CancelledFailure everywhere for cancellation ([1f6fee4](https://github.com/temporalio/sdk-node/commit/1f6fee4ad1d045adc904079a57c6bea741d8bc38))


### BREAKING CHANGES

* use `isCancellation(err)` instead of catching `CancelledError` for
handling cancellations, cancelled activities and child workflows now throw
`ActivityFailure` and `ChildWorkflowFailure` respectively with cause set
to `CancelledFailure`.





## [0.1.3](https://github.com/temporalio/sdk-node/compare/@temporalio/docs@0.1.2...@temporalio/docs@0.1.3) (2021-07-27)

**Note:** Version bump only for package @temporalio/docs





## [0.1.2](https://github.com/temporalio/sdk-node/compare/@temporalio/docs@0.1.1...@temporalio/docs@0.1.2) (2021-06-18)

**Note:** Version bump only for package @temporalio/docs





## [0.1.1](https://github.com/temporalio/sdk-node/compare/@temporalio/docs@0.1.0...@temporalio/docs@0.1.1) (2021-05-17)

**Note:** Version bump only for package @temporalio/docs
