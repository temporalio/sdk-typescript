# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [0.5.0](https://github.com/temporalio/sdk-node/compare/@temporalio/workflow@0.4.0...@temporalio/workflow@0.5.0) (2021-07-27)


### Bug Fixes

* **workflow:** Allow passing number to ActivityOption timeouts ([#138](https://github.com/temporalio/sdk-node/issues/138)) ([42d9642](https://github.com/temporalio/sdk-node/commit/42d964203a23b9ef3021e8224eaf6808f28b4849))
* Throw DeterminismViolationError when a query handler returns a Promise ([0febe2f](https://github.com/temporalio/sdk-node/commit/0febe2f4177c460866ee7bb0c1e1b4dd43e025d8))


### Features

* **workflow:** Expose ActivityCancellationType ([45cc42d](https://github.com/temporalio/sdk-node/commit/45cc42d332d9e45a2587d366a1db123c7c6aa9d0))
* **workflow:** Implement continueAsNew ([d743cdf](https://github.com/temporalio/sdk-node/commit/d743cdfe49ecb6511c8cefbfaf6fd2870e5de670))
* **workflow:** Implement queries ([9ba6424](https://github.com/temporalio/sdk-node/commit/9ba6424b9cc2c17f7b4125bb2324798327c7073f))
* **workflow:** Implement Workflow cancellation ([f489b3a](https://github.com/temporalio/sdk-node/commit/f489b3a55556de8d1e5d42070f97f056767c5ff4))





# [0.4.0](https://github.com/temporalio/sdk-node/compare/@temporalio/workflow@0.3.2...@temporalio/workflow@0.4.0) (2021-06-25)


### Features

* **workflow:** Lazily load user code into Workflow isolate ([990cc1f](https://github.com/temporalio/sdk-node/commit/990cc1fb4347bb8e102c1d8e1b628d5766144a5d))
* Add Workflow AsyncLocalStorage ([5ce2233](https://github.com/temporalio/sdk-node/commit/5ce2233fd7d5a19e6b33e2f30c535fba44fa8ed3))





## [0.3.2](https://github.com/temporalio/sdk-node/compare/@temporalio/workflow@0.3.1...@temporalio/workflow@0.3.2) (2021-06-18)

**Note:** Version bump only for package @temporalio/workflow





## [0.3.1](https://github.com/temporalio/sdk-node/compare/@temporalio/workflow@0.3.0...@temporalio/workflow@0.3.1) (2021-06-18)

**Note:** Version bump only for package @temporalio/workflow





# [0.3.0](https://github.com/temporalio/sdk-node/compare/@temporalio/workflow@0.2.1...@temporalio/workflow@0.3.0) (2021-06-16)


### Bug Fixes

* **workflow:** Fix scope association after promise is resolved ([ee288b4](https://github.com/temporalio/sdk-node/commit/ee288b40ba1a45f7c94b11a360e3ac7a341515b2))
* **workflow:** Workflow overrides do not take effect before starting a Workflow ([d59051c](https://github.com/temporalio/sdk-node/commit/d59051c732e961100ba75fdc431b742a489cfebb))


### Features

* Implement Workflow and Activity interceptors ([8da2300](https://github.com/temporalio/sdk-node/commit/8da230004031d1759b94b7bdb6a7b797e133a4a9))
* Support injecting external dependencies into the Workflow isolate ([ac163b3](https://github.com/temporalio/sdk-node/commit/ac163b3ea48487fe3d31a17e0dee0530e322efee))





## [0.2.1](https://github.com/temporalio/sdk-node/compare/@temporalio/workflow@0.2.0...@temporalio/workflow@0.2.1) (2021-05-17)

**Note:** Version bump only for package @temporalio/workflow
