<p align="center">
  <img src="https://assets.temporal.io/w/ts.png" alt="Temporal TypeScript SDK" />
</p>

![Node 20 | 22 | 24](https://img.shields.io/badge/node-20%20|%2022%20|%2024-blue.svg?style=for-the-badge)
[![MIT](https://img.shields.io/github/license/temporalio/sdk-typescript.svg?style=for-the-badge)](LICENSE)
[![NPM](https://img.shields.io/npm/v/@temporalio/client?style=for-the-badge)](https://www.npmjs.com/search?q=author%3Atemporal-sdk-team)

[Temporal](https://temporal.io/) is a distributed, scalable, durable, and highly available orchestration engine used to
execute asynchronous, long-running business logic in a scalable and resilient way.

**Temporal TypeScript SDK** is the framework for authoring workflows and activities using either the TypeScript or JavaScript programming languages.

For documentation and samples, see:

- [TypeScript Development Guide](https://docs.temporal.io/develop/typescript)
- [TypeScript Samples](https://github.com/temporalio/samples-typescript)
- [TypeScript API Reference](https://typescript.temporal.io/)
- [General Temporal Documentation](https://docs.temporal.io)

## Quick Start

### Installation

To add Temporal TypeScript SDK packages to an existing JavaScript project, run:

_(for client-level features, e.g. starting or interracting with Workflows)_

```sh
# Or `pnpm add` or `yarn add`
npm install --save \
    @temporalio/client \
    @temporalio/common
```

_(for worker-level features, including running Workflows, Activities and Nexus Operations)_

```sh
# Or `pnpm add` or `yarn add`
npm install --save \
    @temporalio/worker \
    @temporalio/workflow \
    @temporalio/activity \
    @temporalio/common
```

All `@temporalio/*` packages in a project must have the same version number.
This requirement is generally enforced by peer dependencies of the Temporal packages,
but it may sometime require extra cares in complex monorepos.

## Requirements

> [!NOTE]
> The following requirements apply to the current git branch, and not necessarily what's released on NPM.

### Node.js

The Temporal TypeScript SDK is officially supported on Node 20, 22, and 24.

In line with [Node.js' release policy](https://nodejs.org/en/about/previous-releases#nodejs-releases),
we recommend that production applications only use Node's Active LTS or Maintenance LTS releases.

### Other JavaScript runtime environments

The `@temporalio/client` package is believed to work properly on most server-side JavaScript
environments, including Bun, Deno, and Cloudflare Workers. Note however that we do not run
regular tests of the SDK on any other JavaScript runtime environments, and therefore can't
provide official support for such execution environments. Use at your own risk!

Worker-level features (i.e. running Workflows, Activities, and Nexus Operations) of the Temporal
TypeScript SDK rely extensively on several Node-specific features, including:

- **Node-API native modules** - Required to load the Core SDK native library.
- **Node's `worker_threads` module** - Required to offload Workflow Tasks execution
  to a separate thread.
- **Node's `vm` modules** - Required to create isolated execution environments for
  Workflow Tasks (i.e. the "Workflow Sandbox").
- **Node's `AsyncLocalStorage` API** - Required to track the context of the currently
  executing Workflow, Activity, or Nexus Operation tasks.
- **Node's `async_hooks` module** - Required to track stack traces and catch unhandled
  promise rejections inside of Workflows.

Some Node-compatible runtimes provide partial support for these APIs, and some users have
reported anecdotal success in running Worker-level features of the Temporal TypeScript SDK
in such environments. However, given the lack of maturity of those compatibility layers, we
strongly discourage running Temporal Workers in anything except authentic Node.js at this time.

Be assured that we will continue to monitor evolution of those alternative runtimes, and will
consider extending support to more environments as their respective compatibility layers mature.

## SDK Development

Refer to our [contributing guide](CONTRIBUTING.md) for contribution expectations. Build and testing procedures are below.

### Environment setup

The Temporal TypeScript SDK is officially supported on Node 20, 22, or 24.
However, we recommend using the [Active LTS](https://nodejs.org/en/about/previous-releases#nodejs-releases)
for SDK development. For easier testing during development, you may want to use
a version manager, such as [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm/blob/master/README.md).

To run tests, you will need access to a local Temporal server, such as the
[Temporal CLI's integrated dev server](https://docs.temporal.io/cli).

Install the [Rust toolchain](https://rustup.rs/) and [Protocol Buffers](https://protobuf.dev/installation/).

Clone the [sdk-typescript](https://github.com/temporalio/sdk-typescript) repo and initialize the Core SDK submodule:

```sh
git clone https://github.com/temporalio/sdk-typescript.git
cd sdk-typescript
git submodule update --init --recursive
```

If you get a `The authenticity of host 'github.com (192.30.252.123)' can't be established.`
error, run `ssh-keyscan github.com >> ~/.ssh/known_hosts` and retry.

TS SDK uses PNPM to manage dependencies. Corepack is the recommended way to install `pnpm` and is included in Node 14+:

```sh
corepack enable
```

Install the dependencies:

```sh
pnpm install --frozen-lockfile
```

This may take a few minutes, as it involves downloading and compiling Rust dependencies.

You should now be able to build:

```sh
pnpm build
```

If building fails, resetting your environment may help:

```sh
pnpm clean
pnpm install --frozen-lockfile
```

If `pnpm install` fails in `@temporalio/core-bridge` on the command `pnpm tsx ./scripts/build.ts`, you may
need to do `rustup update`.

To update to the latest version of the Core SDK, run `git submodule update` followed by `pnpm build` to recompile.

### Development commands

After your environment is set up, you can run these commands:

- `pnpm build` compiles protobuf definitions, Rust bridge, C++ isolate extension, and TypeScript.
- `pnpm run rebuild` deletes all generated files in the project and reruns build.
- `pnpm build:watch` watches filesystem for changes and incrementally compiles TypeScript on change.
- `pnpm test` runs the test suite. Tests assume you have a [Temporal server running locally](https://docs.temporal.io/cli#start-dev-server).
- `pnpm test:watch` runs the test suite on each change to TypeScript files.
- `pnpm format` formats code with prettier.
- `pnpm lint` verifies code style with prettier and ESLint.
- `pnpm commitlint` validates [commit messages](#style-guide).

### Working with Individual Packages

You can build or test a single package using pnpm's filter flag:

```sh
# Build a single package and all its dependencies explicitly
pnpm -F @temporalio/worker... run build

# Run tests for a single package
pnpm -F @temporalio/common run test
```

The `...` suffix includes all dependencies of the specified package.

### Testing

#### Testing local changes to core

Create a `.cargo/config.toml` file and override the path to sdk-core and/or sdk-core-protos as
described [here](https://doc.rust-lang.org/cargo/reference/overriding-dependencies.html#paths-overrides).

#### Integration tests

In order to run integration tests:

1. Run the Temporal server, such as the [Temporal CLI's integrated dev server](https://github.com/temporalio/cli#start-the-server).
2. Export `RUN_INTEGRATION_TESTS=true`.

#### test-npm-init

To replicate the `test-npm-init` CI test locally, you can start with the below steps:

> If you've run `npx @temporalio/create` before, you may need to delete the version of the package that's stored in `~/.npm/_npx/`.

```sh
pnpm install --frozen-lockfile
pnpm run rebuild

TMP_DIR=$(mktemp -d)

pnpm tsx scripts/publish-to-verdaccio.ts --registry-dir "$TMP_DIR"
pnpm tsx scripts/init-from-verdaccio.ts --registry-dir "$TMP_DIR" --target-dir "./example" --sample hello-world
pnpm tsx scripts/test-example.ts --work-dir "./example"

rm -rf ./example "$TMP_DIR"
```

### Style Guide

- TypeScript code is linted with [ESLint](https://eslint.org/).
- Files in this repo are formatted with [prettier](https://prettier.io/).
- Prefer explicit named re-exports and avoid wildcard re-exports where possible (`export * from ...`) in public entrypoint / barrel files.
- Use `@experimental` and `@internal` to manage API stability and visibility. Mark new or work-in-progress exported APIs `@experimental` to signal their shape may still change. Mark a symbol `@internal` to keep it out of the generated public docs. The two are independent and may be combined. It is fine to ship something `@internal` now and promote it to public later, by removing `@internal` and adding a named re-export, once it is actually usable. The reverse is a breaking change, so prefer starting narrow.
- Pull request titles SHOULD adhere to the [Conventional Commits specification](https://conventionalcommits.org/), for example:

```text
<type>(optional scope): <description>

chore(samples): upgrade commander module
```

The `scope` options are listed in [commitlint.config.js](commitlint.config.js).

### Updating and pruning dependencies

There are various tools out there to help with updating and pruning NPM dependencies.

One approach for finding NPM packages that need to be updated is to run:

```sh
for i in ./package.json packages/*/package.json contrib/*/package.json; do
  (
    cd "${i%%package.json}"
    pwd
    npm-check-updates -i
  )
done
```

To identify unused dependencies, you can run:

```sh
for i in ./package.json packages/*/package.json contrib/*/package.json; do
  (
    cd "${i%%package.json}"
    pwd
    npm-check
  )
done
```

Note that `npm-check` may report false positives. Search the code before actually deleting any dependency. Also note that runtime
dependencies MUST be added on the actual packages that use them to ensure proper execution in PNPM and YARN 2+ setups.

To install both tools: `npm i -g npm-check npm-check-updates`.

### Repository Structure

This monorepo contains the following packages:

| Subfolder                                                                    | Package                                                                                                          |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`packages/client/`](packages/client/)                                       | [`@temporalio/client`](https://www.npmjs.com/package/@temporalio/client)                                         |
| [`packages/worker/`](packages/worker/)                                       | [`@temporalio/worker`](https://www.npmjs.com/package/@temporalio/worker)                                         |
| [`packages/workflow/`](packages/workflow/)                                   | [`@temporalio/workflow`](https://www.npmjs.com/package/@temporalio/workflow)                                     |
| [`packages/activity/`](packages/activity/)                                   | [`@temporalio/activity`](https://www.npmjs.com/package/@temporalio/activity)                                     |
| [`packages/testing/`](packages/testing/)                                     | [`@temporalio/testing`](https://www.npmjs.com/package/@temporalio/testing)                                       |
| [`packages/common/`](packages/common/)                                       | [`@temporalio/common`](https://www.npmjs.com/package/@temporalio/common)                                         |
| [`packages/proto/`](packages/proto/)                                         | [`@temporalio/proto`](https://www.npmjs.com/package/@temporalio/proto)                                           |
| [`packages/test/`](packages/test/)                                           | SDK internal tests                                                                                               |
| [`packages/create-project/`](packages/create-project/)                       | [`@temporalio/create`](https://www.npmjs.com/package/@temporalio/create-project)                                 |
| [`packages/docs/`](packages/docs/)                                           | [API docs](https://typescript.temporal.io/)                                                                      |
| [`packages/core-bridge/`](packages/core-bridge/)                             | [`@temporalio/core-bridge`](https://www.npmjs.com/package/@temporalio/proto)                                     |
| [`packages/envconfig/`](packages/envconfig/)                                 | [`@temporalio/envconfig`](https://www.npmjs.com/package/@temporalio/envconfig)                                   |
| [`packages/nyc-test-coverage/`](packages/nyc-test-coverage/)                 | [`@temporalio/nyc-test-coverage`](https://www.npmjs.com/package/@temporalio/nyc-test-coverage)                   |
| [`packages/plugin/`](packages/plugin/)                                       | [`@temporalio/plugin`](https://www.npmjs.com/package/@temporalio/plugin)                                         |
| [`packages/nexus/`](packages/nexus/)                                         | [`@temporalio/nexus`](https://www.npmjs.com/package/@temporalio/nexus)                                           |
| [`contrib/interceptors-opentelemetry/`](contrib/interceptors-opentelemetry/) | [`@temporalio/interceptors-opentelemetry`](https://www.npmjs.com/package/@temporalio/interceptors-opentelemetry) |
| [`contrib/ai-sdk/`](contrib/ai-sdk/)                                         | [`@temporalio/ai-sdk`](https://www.npmjs.com/package/@temporalio/ai-sdk)                                         |

## Contributing

We welcome issues and pull requests!

Please read our [contributing guide](CONTRIBUTING.md) to learn about our
development process, and how to propose bugfixes and improvements.

Thank you to [everyone who has contributed](https://github.com/temporalio/sdk-typescript/graphs/contributors) to the Temporal TypeScript SDK 😃🙌
