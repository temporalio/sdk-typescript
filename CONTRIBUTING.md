# How to Contribute

The TypeScript SDK (as well as the rest of the Temporal codebase) is open sourced under the MIT license.

We welcome contributions from the community. To contribute please start by opening an [issue](https://github.com/temporalio/sdk-typescript/issues) and discussing the proposed change. Once a change has been agreed upon, development may start and be submitted via a [pull request](https://github.com/temporalio/sdk-typescript/pulls).

### Contributor License Agreement (CLA)

Contributors must agree to the CLA before their PR can be merged. You only have to do this once. Follow [this link](https://cla-assistant.io/temporalio/sdk-typescript) and sign in with your GitHub account.

### SDK Structure

See [sdk-structure.md](./docs/sdk-structure.md)

### Environment setup

- Install the system dependencies listed in [Getting started > Step 0: Prerequisites](https://docs.temporal.io/docs/node/getting-started/#step-0-prerequisites)
- Install the [Rust toolchain](https://rustup.rs/)
- Clone the [sdk-typescript](https://github.com/temporalio/sdk-typescript) repo:
  ```sh
  git clone https://github.com/temporalio/sdk-typescript.git
  cd sdk-typescript
  ```
- Initialize the Core SDK submodule:
  ```sh
  git submodule update --init --recursive
  ```
  > If you get a `The authenticity of host 'github.com (192.30.252.123)' can't be established.` error, run `ssh-keyscan github.com >> ~/.ssh/known_hosts` and retry.
- Install the dependencies:
  ```sh
  npm ci
  ```
  This may take a few minutes, as it involves downloading and compiling Rust dependencies.
- You should now be able to build:
  ```sh
  npm run build
  ```

If building fails, resetting your environment may help:

```
npx lerna clean -y && npm ci
```

If `npm ci` fails in `@temporalio/core-bridge` on the command `node ./scripts/build.js`, you may need to do `rustup update`.

To update to the latest version of the Core SDK, run `git submodule update` followed by `npm run build` to recompile.

> For cross compilation on MacOS follow [these instructions](https://github.com/temporalio/sdk-typescript/blob/main/docs/building.md) (only required for publishing packages).

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

### Testing

#### Testing local changes to core

Create a `.cargo/config.toml` file and override the path to sdk-core and/or sdk-core-protos as
described [here](https://doc.rust-lang.org/cargo/reference/overriding-dependencies.html#paths-overrides)

##### Integration tests

In order to run integration tests:

1. Run the temporal server using [docker-compose](https://github.com/temporalio/docker-compose).
1. Export `RUN_INTEGRATION_TESTS=true`

#### test-npm-init

To replicate the `test-npm-init` CI test locally, you can start with the below steps:

> If you've run `npx @temporalio/create` before, you may need to delete the version of the package that's stored in `~/.npm/_npx/`.

```
rm -rf /tmp/registry
npm ci
npm run rebuild
node scripts/publish-to-verdaccio.js --registry-dir /tmp/registry
node scripts/init-from-verdaccio.js --registry-dir /tmp/registry --sample hello-world
cd /tmp/registry/example
npm run build
node ~/path-to/sdk-typescript/scripts/test-example.js --work-dir /tmp/registry/example
```

### Style Guide

- Typescript code is linted with [eslint](https://eslint.org/)
- Files in this repo are formatted with [prettier](https://prettier.io/)
- Pull request titles SHOULD adhere to the [Conventional Commits specification](https://conventionalcommits.org/), for example:

```
<type>(optional scope): <description>

chore(samples): upgrade commander module
```

The `scope` options are listed in [commitlint.config.js](https://github.com/temporalio/sdk-typescript/blob/main/commitlint.config.js).
