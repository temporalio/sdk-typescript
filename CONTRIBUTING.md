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

- [Roey `bergundy`](https://github.com/bergundy)
- [James `mjameswh`](https://github.com/mjameswh)

If you'd like to join us, [email Roey](mailto:roey@temporal.io). We'd be happy to have help with any of these things:

- Triaging issues
- Reviewing PRs
- Submitting PRs to close issues

## Getting started

### Contributor License Agreement (CLA)

Contributors must agree to the CLA before their PR can be merged. You only have to do this once. Follow [this link](https://cla-assistant.io/temporalio/sdk-typescript) and sign in with your GitHub account.

### SDK Structure

See [sdk-structure.md](./docs/sdk-structure.md)

### Environment setup

- The TS SDK can be executed on Node 14.18+, 16, 18 and 20. However, for SDK development, we recommend using Node 20. For easier testing, you may want to use a version manager, such as: [nvm](https://github.com/nvm-sh/nvm/blob/master/README.md) or [volta](https://volta.sh/)
- To run tests, you will need access to a local Temporal server. You may use either the [Temporal CLI's integrated dev server](https://github.com/temporalio/cli#start-the-server) or a [Docker container](https://github.com/temporalio/docker-compose#temporal-server-docker-compose-files),
- Install the [Rust toolchain](https://rustup.rs/)
- Install [Protocol Buffers](https://github.com/protocolbuffers/protobuf/releases/)
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

1. Run the temporal server using either the [Temporal CLI's integrated dev server](https://github.com/temporalio/cli#start-the-server) or a [Docker container](https://github.com/temporalio/docker-compose#temporal-server-docker-compose-files)
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

## Updating and pruning dependencies

There are various tools out there to help with updating and pruning NPM dependencies. Unfortunately,
most of these tools don't work well in older lerna-style monorepos, such as this one, and updating
to NPM 7 workspace would break support for Node 14.x. We must therefore rely on a more manual
approach.

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

- If PRs came from external contributors, thank them & link their github handles: `([#484](link), thanks to [`@user`](https://github.com/user) 🙏)`
- Open PR with CHANGELOG change
- If using a custom [features](https://github.com/temporalio/features) branch for PR integration tests, make
  sure the branch is fully up-to-date with `features` `main` before merging the CHANGELOG PR
- Merge PR
- Checkout latest `main`

We're [working on automating](https://github.com/temporalio/sdk-typescript/pull/395) the rest of the process:

- Log in to npm as `temporal-sdk-team` (`npm whoami` and `npm login`)
- Download the 5 `packages-*` artifacts from the PR's [GitHub Action](https://github.com/temporalio/sdk-typescript/actions)
- Publish:

```sh
#!/bin/bash
set -euo pipefail

git clean -fdx
npm ci
npm run build

mkdir -p packages/core-bridge/releases

# in the next command, replace ~/gh/release-sdk-typescript with your dir
for f in ~/Downloads/packages-*.zip; do mkdir "$HOME/Downloads/$(basename -s .zip $f)"; (cd "$HOME/Downloads/$(basename -s .zip $f)" && unzip $f && tar -xvzf @temporalio/core-bridge/core-bridge-*.tgz package/releases/ && cp -r package/releases/* ~/gh/release-sdk-typescript/packages/core-bridge/releases/); done

# we should now have all 5 build targets
ls packages/core-bridge/releases/

npx lerna version patch --force-publish='*' # or major|minor|etc, or leave out to be prompted. either way, you get a confirmation dialog.

git checkout -B fix-deps
node scripts/prepublish.mjs
git commit -am 'Fix dependencies'
npx lerna publish from-package # add `--dist-tag next` for pre-release versions
git checkout -
```

Finally:

```
npm deprecate temporalio@^1.0.0 "Instead of installing temporalio, we recommend directly installing our packages: npm remove temporalio; npm install @temporalio/client @temporalio/worker @temporalio/workflow @temporalio/activity"
```

- Cleanup after publishing:

  ```sh
  rm -rf $HOME/Downloads/packages-*
  rm -rf packages/core-bridge/releases/*
  ```

- If using a custom [features](https://github.com/temporalio/features/) branch for PR integration tests, merge
  that branch into features `main` and update the SDK workflow definition to trigger `features` `main`

- If any APIs have changed, open a PR to update [`samples-typescript`](https://github.com/temporalio/samples-typescript/). Once merged, update the `next` branch:

  ```sh
  git checkout next
  git rebase origin/main
  git push
  ```

- While our tests should capture most things, if you want to verify the release works in the samples, do:

  ```sh
  cd /path/to/samples-typescript
  lerna exec -- npm update
  npm run build
  npm test
  ```

### Updating published packages

`npm` commands we may need to use:

If we publish a version like `1.1.0-rc.1` with tag `next`, we untag it after `1.1.0` is released:

```
npm dist-tag rm @temporalio/client next
npm dist-tag rm @temporalio/worker next
npm dist-tag rm @temporalio/workflow next
npm dist-tag rm @temporalio/activity next
npm dist-tag rm @temporalio/testing next
npm dist-tag rm @temporalio/common next
npm dist-tag rm @temporalio/proto next
npm dist-tag rm @temporalio/interceptors-opentelemetry next
npm dist-tag rm @temporalio/common/lib/internal-workflow next
npm dist-tag rm @temporalio/common/lib/internal-non-workflow next
npm dist-tag rm @temporalio/create next
npm dist-tag rm temporalio next
```
