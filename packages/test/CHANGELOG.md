# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [0.5.0](https://github.com/temporalio/sdk-node/compare/@temporalio/test@0.4.2...@temporalio/test@0.5.0) (2021-06-25)


### Bug Fixes

* **workflow:** Pass max isolate memory limit option to isolate ([8d6d3d2](https://github.com/temporalio/sdk-node/commit/8d6d3d204ca4a6734dcbe84248e47e074debfa49))
* **workflow:** Report filename when reporting workflow not found ([#121](https://github.com/temporalio/sdk-node/issues/121)) ([f6af189](https://github.com/temporalio/sdk-node/commit/f6af189b2f38b1d3989b9982b6cb1a47204c3dec))


### Features

* **workflow:** Lazily load user code into Workflow isolate ([990cc1f](https://github.com/temporalio/sdk-node/commit/990cc1fb4347bb8e102c1d8e1b628d5766144a5d))
* Add Workflow AsyncLocalStorage ([5ce2233](https://github.com/temporalio/sdk-node/commit/5ce2233fd7d5a19e6b33e2f30c535fba44fa8ed3))





## [0.4.2](https://github.com/temporalio/sdk-node/compare/@temporalio/test@0.4.1...@temporalio/test@0.4.2) (2021-06-18)

**Note:** Version bump only for package @temporalio/test





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
