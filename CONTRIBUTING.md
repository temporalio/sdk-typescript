# How to Contribute

The Node.js SDK (as well as the rest of the Temporal codebase) is open sourced under the MIT license.

We welcome contributions from the community. To contribute please start by opening an [issue](https://github.com/temporalio/sdk-node/issues) and discussing the proposed change. Once a change has been agreed upon, development may start and be submitted via a [pull request](https://github.com/temporalio/sdk-node/pulls).

**Contents**:

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Contributor License Agreement (CLA)](#contributor-license-agreement-cla)
- [SDK Structure](#sdk-structure)
- [Environment setup](#environment-setup)
- [Development Workflow](#development-workflow)
  - [Integration tests](#integration-tests)
- [Style Guide](#style-guide)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

### Contributor License Agreement (CLA)

Contributors must agree to the CLA before their PR can be merged. You only have to do this once. Follow [this link](https://cla-assistant.io/temporalio/sdk-node) and sign in with your GitHub account.

### SDK Structure

See [sdk-structure.md](./docs/sdk-structure.md)

### Environment setup

- Install the system dependencies listed in [Getting started > Step 0: Prerequisites](https://docs.temporal.io/docs/node/getting-started/#step-0-prerequisites)
- Install the [Rust toolchain](https://rustup.rs/)
- Clone the [sdk-node](https://github.com/temporalio/sdk-node) repo:
  ```sh
  git clone https://github.com/temporalio/sdk-node.git
  cd sdk-node
  ```
- Initialize the Core SDK submodule:
  ```sh
  git submodule init
  git submodule update
  ```
- Install the dependencies:
  ```sh
  npm ci
  ```

You should now be able to successfully do `npm run build`. If this fails, resetting your environment may help: `npx lerna clean -- -f && npm ci`.

To update your environment, run `git submodule update` to update to the latest version of the Core SDK, followed by `npm run build` to recompile.

> For cross compilation on MacOS follow [these instructions](https://github.com/temporalio/sdk-node/blob/main/docs/building.md) (only required for publishing packages).

### Development Workflow

After your environment is set up, you can run these commands:

- `npm run build` compiles protobuf definitions, Rust bridge, C++ isolate extension, and Typescript.
- `npm run rebuild` deletes all generated files in the project and reruns build.
- `npm run build.watch` watches filesystem for changes and incrementally compiles Typescript on change.
- `npm run test` runs the test suite.
- `npm run test.watch` runs the test suite on each change to Typescript files.
- `npm run format` formats code with prettier.
- `npm run lint` verifies code style with prettier and ES lint.

#### Integration tests

In order to run integration tests:

1. Run the temporal server using [docker-compose](https://github.com/temporalio/docker-compose).
1. Export `RUN_INTEGRATION_TESTS=true`

### Style Guide

- Typescript code is linted with [eslint](https://eslint.org/)
- Files in this repo are formatted with [prettier](https://prettier.io/)
- All pull requests SHOULD adhere to the [Conventional Commits specification](https://conventionalcommits.org/)
