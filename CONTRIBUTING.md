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
- [Updating the Java test server proto files](#updating-the-java-test-server-proto-files)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

The TypeScript SDK (as well as the rest of the Temporal codebase) is open sourced under the MIT license.

We welcome contributions from the community. To contribute, please start by opening an [issue](https://github.com/temporalio/sdk-typescript/issues) and discussing the proposed change. Once a change has been agreed upon, development may start and be submitted via a [pull request](https://github.com/temporalio/sdk-typescript/pulls).

## Maintenance

The current maintainers are:

- [Loren `lorensr`](https://github.com/lorensr)
- [Roey `bergundy`](https://github.com/bergundy)

If you'd like to join us, [email Loren](mailto:loren@temporal.io). We'd be happy to have help with any of these things:

- Triaging issues
- Reviewing PRs
- Submitting PRs to close issues

## Getting started

### Contributor License Agreement (CLA)

Contributors must agree to the CLA before their PR can be merged. You only have to do this once. Follow [this link](https://cla-assistant.io/temporalio/sdk-typescript) and sign in with your GitHub account.

### SDK Structure

See [sdk-structure.md](./docs/sdk-structure.md)

### Environment setup

- Install Node 16 and [Temporal Server](https://github.com/temporalio/docker-compose#temporal-server-docker-compose-files)
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

## Development

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

## Publishing

First, follow the instructions in [docs/building.md](docs/building.md).

```sh
cargo install git-cliff
```

```sh
# git-cliff --tag <new version> <current version>..HEAD | pbcopy
git-cliff --tag 1.0.1 v1.0.0..HEAD | pbcopy
```

- Paste into [CHANGELOG.md](CHANGELOG.md)
- Clean up formatting
- Add any important missing details
- Replace PR numbers with links:

```
#(\d{3})
[#$1](https://github.com/temporalio/sdk-typescript/pull/$1)
```

- Open PR with CHANGELOG change
- Merge PR
- Checkout latest `main`

We're [working on automating](https://github.com/temporalio/sdk-typescript/pull/395) the rest of the process:

- Log in to npm as `temporal-sdk-team`
- Download the artifacts from [GitHub Actions](https://github.com/temporalio/sdk-typescript/actions)
- Publish:

```sh
#!/bin/bash
set -euo pipefail

git clean -fdx
npm ci
npm run build

for f in ~/Downloads/packages-*.zip; do mkdir "$HOME/Downloads/$(basename -s .zip $f)"; (cd "$HOME/Downloads/$(basename -s .zip $f)" && unzip $f && tar -xvzf @temporalio/core-bridge/core-bridge-*.tgz package/releases/ && cp -r package/releases/* ~/gh/release-sdk-typescript/packages/core-bridge/releases/); done

# we don't build for aarch64-linux in CI, so we build for it now
export CC_aarch64_unknown_linux_gnu=aarch64-unknown-linux-gnu-gcc
export CC_x86_64_unknown_linux_gnu=x86_64-unknown-linux-gnu-gcc
export TEMPORAL_WORKER_BUILD_TARGETS=aarch64-unknown-linux-gnu
npx lerna run --stream build-rust -- -- --target ${TEMPORAL_WORKER_BUILD_TARGETS}
# we should now have all 5 build targets
ls packages/core-bridge/releases/

npx lerna version patch # or major|minor|etc, or leave out to be prompted. either way, you get a confirmation dialog.
npx lerna publish from-git # add `--dist-tag next` for pre-release versions
```

- Cleanup:

```sh
rm $HOME/Downloads/packages-*
```

## Updating the Java test server proto files

[These files](https://github.com/temporalio/sdk-java/tree/master/temporal-test-server/src/main/proto) are taken from the `sdk-java` repo.

```sh
# Add sdk-java as a git remote
git remote get-url sdk-java || git remote add sdk-java git@github.com:temporalio/sdk-java.git

# Checkout and pull sdk-java master
git checkout -B sdk-java-master sdk-java/master
git pull

# Delete this branch in case it already exists
git branch -D sdk-java-master-proto-only

# Pick only the 'proto' directory
git subtree split --squash --prefix=temporal-test-server/src/main/proto/ -b sdk-java-master-proto-only

# Fix the proto paths so they can be checked out into the proper location
gco sdk-java-master-proto-only
mkdir -p packages/testing/proto
git mv $(git ls-files | cut -d / -f 1 | uniq) packages/testing/proto
git commit -m 'Move protos to testing package'

# Checkout the destination branch (the below command creates a new branch but this is not required)
git checkout -b my-branch-for-pull-request

# Checkout all proto changes into current branch
gco sdk-java-master-proto-only packages/testing
```
