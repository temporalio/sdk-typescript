# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

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
