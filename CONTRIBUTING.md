# How to Contribute

The NodeJS SDK, as well as the rest of the Temporal codebase is open sourced under the MIT license.

We welcome contributions from the community. To contribute please start by opening an [issue](https://github.com/temporalio/sdk-node/issues) and dicussing the proposed change, once a change has been agreed upon development may start and submitted via a [pull request](https://github.com/temporalio/sdk-node/pulls).

### Contributor License Agreement (CLA)

You will need to submit a CLA before we can accept your contribution. You only have to do this once. Follow [this link](https://cla-assistant.io/temporalio/sdk-node) and sign in with your GitHub account.

### [SDK Structure](./docs/sdk-structure.md)

### Environment set up

- Install system dependencies including the rust toolchain by follow the instructions [here](https://docs.temporal.io/docs/node/getting-started#install-system-dependencies)
- Clone the [sdk-node](https://github.com/temporalio/sdk-node) repo
- Initialize the Core SDK submodule
  ```sh
  git submodule init
  git submodule update
  ```
- Install the dependencies
  ```sh
  npm ci
  ```

> For cross compilation on MacOS follow [these](https://github.com/temporalio/sdk-node/blob/main/docs/building.md) instructions.

### Development Workflow

After your environment is set up, you can run these commands:

- `npm run build` compiles protobuf definitions, Rust bridge, C++ isolate extension, and Typescript.
- `npm run rebuild` deletes all generated files in the project and reruns build.
- `npm run build.watch` watches filesystem for changes and incrementally compiles Typescript on change.
- `npm run test` runs the test suite.
- `npm run test.watch` runs the test suite on each change to Typescript files.
- `npm run format` formats code with prettier.
- `npm run lint` verifies code style with prettier and ES lint.

##### Integration tests

In order to run integration tests:

1. Run the temporal server using [docker-compose](https://github.com/temporalio/docker-compose).
1. Export `RUN_INTEGRATION_TESTS=true`
