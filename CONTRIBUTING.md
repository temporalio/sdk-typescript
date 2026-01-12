# How to Contribute

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

**Table of Contents**

- [Maintenance](#maintenance)
- [Getting started](#getting-started)
  - [Contributor License Agreement (CLA)](#contributor-license-agreement-cla)
  - [SDK Structure](#sdk-structure)
  - [Environment setup](#environment-setup)
- [Development](#development)
  - [Testing](#testing)
    - [Testing local changes to core](#testing-local-changes-to-core)
      - [Integration tests](#integration-tests)
    - [test-npm-init](#test-npm-init)
  - [Style Guide](#style-guide)
- [Publishing](#publishing)
- [Updating published packages](#updating-published-packages)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

The Temporal TypeScript SDK (as well as the rest of the Temporal codebase) is open sourced under the MIT license.

We welcome contributions from the community. To contribute, please start by opening an [issue](https://github.com/temporalio/sdk-typescript/issues) and discussing the proposed change. Once a change has been agreed upon, development may start and be submitted via a [pull request](https://github.com/temporalio/sdk-typescript/pulls).

## Maintenance

If you'd like to give a hand, please reach us on our [community Slack workspace](https://temporalio.slack.com/channels/typescript-sdk). We'd be happy to have help with any of these things:

- Triaging issues
- Reviewing PRs
- Submitting PRs to close issues

## Getting started

### Contributor License Agreement (CLA)

Contributors must agree to the CLA before their PR can be merged. You only have to do this once. Follow [this link](https://cla-assistant.io/temporalio/sdk-typescript) and sign in with your GitHub account.

### Environment setup

The Temporal TypeScript SDK is officially supported on Node 18, 20, 22, or 24.
However, we recommend using the [Active LTS](https://nodejs.org/en/about/previous-releases#nodejs-releases)
for SDK development. For easier testing during development, you may want to use
a version manager, such as [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm/blob/master/README.md).

1. To run tests, you will need access to a local Temporal server, e.g. using the
   [Temporal CLI's integrated dev server](https://github.com/temporalio/cli#start-the-server).
2. Install the [Rust toolchain](https://rustup.rs/).
3. Install [Protocol Buffers](https://github.com/protocolbuffers/protobuf/releases/).
4. Clone the [sdk-typescript](https://github.com/temporalio/sdk-typescript) repo:

   ```sh
   git clone https://github.com/temporalio/sdk-typescript.git
   cd sdk-typescript
   ```

5. Initialize the Core SDK submodule:

   ```sh
   git submodule update --init --recursive
   ```

   > If you get a `The authenticity of host 'github.com (192.30.252.123)' can't be established.`
   > error, run `ssh-keyscan github.com >> ~/.ssh/known_hosts` and retry.

6. Install `pnpm`
   TS SDK uses PNPM to manage dependencies. Corepack is the recommend way to install `pnpm` and is included in Node 14+

```sh
corepack enable
```

7. Install the dependencies:

   ```sh
   pnpm install --frozen-lockfile
   ```

   This may take a few minutes, as it involves downloading and compiling Rust dependencies.

You should now be able to build:

```sh
pnpm run build
```

If building fails, resetting your environment may help:

```
pnpm run clean -y
pnpm install --frozen-lockfile
```

If `pnpm install` fails in `@temporalio/core-bridge` on the command `pnpm tsx ./scripts/build.ts`, you may
need to do `rustup update`.

To update to the latest version of the Core SDK, run `git submodule update` followed by `pnpm run build` to recompile.

## Development

After your environment is set up, you can run these commands:

- `pnpm run build` compiles protobuf definitions, Rust bridge, C++ isolate extension, and Typescript.
- `pnpm run rebuild` deletes all generated files in the project and reruns build.
- `pnpm run build:watch` watches filesystem for changes and incrementally compiles Typescript on change.
- `pnpm run test` runs the test suite.
- `pnpm run test:watch` runs the test suite on each change to Typescript files.
- `pnpm run format` formats code with prettier.
- `pnpm run lint` verifies code style with prettier and ES lint.
- `pnpm run commitlint` validates [commit messages](#style-guide).

### Testing

#### Testing local changes to core

Create a `.cargo/config.toml` file and override the path to sdk-core and/or sdk-core-protos as
described [here](https://doc.rust-lang.org/cargo/reference/overriding-dependencies.html#paths-overrides)

##### Integration tests

In order to run integration tests:

1. Run the Temporal server, e.g. using the [Temporal CLI's integrated dev server](https://github.com/temporalio/cli#start-the-server)
1. Export `RUN_INTEGRATION_TESTS=true`

#### test-npm-init

To replicate the `test-npm-init` CI test locally, you can start with the below steps:

> If you've run `npx @temporalio/create` before, you may need to delete the version of the package that's stored in `~/.npm/_npx/`.

```
pnpm install --frozen-lockfile
pnpm run rebuild

TMP_DIR=$( mktemp -d )

pnpm tsx scripts/publish-to-verdaccio.ts --registry-dir "$TMP_DIR"
pnpm tsx scripts/init-from-verdaccio.ts --registry-dir "$TMP_DIR" --target-dir "./example" --sample hello-world
pnpm tsx scripts/test-example.ts --work-dir "./example"

rm -rf ./example "$TMP_DIR"
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

## Updating and pruning dependencies

There are various tools out there to help with updating and pruning NPM dependencies.

I personally use the following commands to find NPM packages that needs to be updated. It runs
interactively on each package of the repo, making it easy to select and apply packages to be updated.

```
for i in ./package.json packages/*/package.json ; do
  (
    cd "${i%%package.json}"
    pwd
    npm-check-updates -i
  )
done
```

To identify unused dependencies, I run the following script. Note that `npm-check` may report
false-positive. Search the code before actually deleting any dependency. Also note that runtime
dependencies MUST be added on the actual packages that use them to ensure proper execution in PNPM
and YARN 2+ setups.

```
for i in ./package.json packages/*/package.json ; do
  (
    cd "${i%%package.json}"
    pwd
    npm-check
  )
done
```

To install both tools: `npm i -g npm-check npm-check-updates`.
