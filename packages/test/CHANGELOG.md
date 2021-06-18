# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [0.4.1](https://github.com/temporalio/sdk-node/compare/@temporalio/test@0.4.0...@temporalio/test@0.4.1) (2021-06-18)

**Note:** Version bump only for package @temporalio/test





# [0.4.0](https://github.com/temporalio/sdk-node/compare/@temporalio/test@0.3.0...@temporalio/test@0.4.0) (2021-06-16)


### Bug Fixes

* **workflow:** Fix scope association after promise is resolved ([ee288b4](https://github.com/temporalio/sdk-node/commit/ee288b40ba1a45f7c94b11a360e3ac7a341515b2))
* **workflow:** Workflow overrides do not take effect before starting a Workflow ([d59051c](https://github.com/temporalio/sdk-node/commit/d59051c732e961100ba75fdc431b742a489cfebb))


### Features

* Implement Workflow and Activity interceptors ([8da2300](https://github.com/temporalio/sdk-node/commit/8da230004031d1759b94b7bdb6a7b797e133a4a9))
* Support injecting external dependencies into the Workflow isolate ([ac163b3](https://github.com/temporalio/sdk-node/commit/ac163b3ea48487fe3d31a17e0dee0530e322efee))





# [0.3.0](https://github.com/temporalio/sdk-node/compare/@temporalio/test@0.2.0...@temporalio/test@0.3.0) (2021-05-17)


### Features

* **bench:** Support --ns arg, poll concurrency configuration and default to 100 concurrenct WFT executions ([0f60013](https://github.com/temporalio/sdk-node/commit/0f600136c6046a5f2f3e3033c31418b88fab14c5))
* **core:** Update core to support background heartbeats and TLS connection ([082f994](https://github.com/temporalio/sdk-node/commit/082f9949ddef3a1ec2271eacb3fc2a9cb2a1cc6d))


### BREAKING CHANGES

* **core:** `WorkerOptions.maxConcurrentActivityExecutions` was renamed `maxConcurrentActivityTaskExecutions`.
