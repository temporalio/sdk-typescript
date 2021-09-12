# How to Contribute

The Node.js SDK, as well as the rest of the Temporal codebase is open sourced under the MIT license.

We welcome contributions from the community. To contribute please start by opening an [issue](https://github.com/temporalio/sdk-node/issues) and dicussing the proposed change, once a change has been agreed upon development may start and submitted via a [pull request](https://github.com/temporalio/sdk-node/pulls).

### Contributor License Agreement (CLA)

You will need to submit a CLA before we can accept your contribution. You only have to do this once. Follow [this link](https://cla-assistant.io/temporalio/sdk-node) and sign in with your GitHub account.

### [SDK Structure](./docs/sdk-structure.md)

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

You should now be able to successfully do `npm run build`. If this fails, resetting your environment may help:

```
npx lerna clean -y && npm ci
```

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
- `npm run commitlint` validates [commit messages](#style-guide).

### Testing local changes to core

Create a `.cargo/config.toml` file and override the path to sdk-core and/or sdk-core-protos as
described [here](https://doc.rust-lang.org/cargo/reference/overriding-dependencies.html#paths-overrides)

##### Integration tests

In order to run integration tests:

1. Run the temporal server using [docker-compose](https://github.com/temporalio/docker-compose).
1. Export `RUN_INTEGRATION_TESTS=true`

### Style Guide

- Typescript code is linted with [eslint](https://eslint.org/)
- Files in this repo are formatted with [prettier](https://prettier.io/)
- All commits SHOULD adhere to the [Conventional Commits specification](https://conventionalcommits.org/) with sentence case descriptions, for example:

```
<type>(optional scope): <description>

chore(samples): Upgrade commander module
```

The `scope` options are listed in [commitlint.config.js](https://github.com/temporalio/sdk-node/blob/main/commitlint.config.js).
