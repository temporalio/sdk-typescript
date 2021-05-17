# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [0.3.0](https://github.com/temporalio/sdk-node/compare/@temporalio/test@0.2.0...@temporalio/test@0.3.0) (2021-05-17)


### Features

* **bench:** Support --ns arg, poll concurrency configuration and default to 100 concurrenct WFT executions ([0f60013](https://github.com/temporalio/sdk-node/commit/0f600136c6046a5f2f3e3033c31418b88fab14c5))
* **core:** Update core to support background heartbeats and TLS connection ([082f994](https://github.com/temporalio/sdk-node/commit/082f9949ddef3a1ec2271eacb3fc2a9cb2a1cc6d))


### BREAKING CHANGES

* **core:** `WorkerOptions.maxConcurrentActivityExecutions` was renamed `maxConcurrentActivityTaskExecutions`.
