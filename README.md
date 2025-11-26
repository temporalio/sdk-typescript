<p align="center">
  <img src="https://assets.temporal.io/w/ts.png" alt="Temporal TypeScript SDK" />
</p>

![Node 18 | 20 | 22 | 24](https://img.shields.io/badge/node-18%20|%2020%20|%2022%20|%2024-blue.svg?style=for-the-badge)
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

The Temporal TypeScript SDK is officially supported on Node 18, 20, 22, and 24.

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

### Prerequisites

To build the Temporal TypeScript SDK from source, you will need to have:

- [Node.js](https://nodejs.org/) (usage of a version manager, such as [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm/blob/master/README.md), is recommended)
- [Rust](https://www.rust-lang.org/) (i.e. `cargo` on the `PATH`)
- [Protobuf Compiler](https://protobuf.dev/) (i.e. `protoc` on the `PATH`)
- This repository, cloned recursively

To run tests locally, you will need:

- A Temporal Server instance accessible from `127.0.0.1:7233` (e.g. using the [Temporal CLI](https://docs.temporal.io/cli/temporal-cli#run-a-local-temporal-server))

### Building

With all prerequisites in place, run the following commands from the root of the repository:

```sh
pnpm install
pnpm build
```

Run `pnpm rebuild` to delete all generated files and rerun build.

Refer to our [contributing guide](CONTRIBUTING.md) for details on other build
procedures, as well as hints on resolving frequent build time issues.

### Testing

To run the SDK's regular test suite, execute the following command from the root of the repository:

```sh
pnpm test
```

Refer to our [contributing guide](CONTRIBUTING.md) for details on other testing procedures.

### Code Formatting and Linting

To format and lint the code, execute the following commands from the root of the repository:

```sh
pnpm format
pnpm lint
```

### Repository Structure

This monorepo contains the following packages:

| Subfolder                                                                      | Package                                                                                                          |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [`packages/client/`](packages/client/)                                         | [`@temporalio/client`](https://www.npmjs.com/package/@temporalio/client)                                         |
| [`packages/worker/`](packages/worker/)                                         | [`@temporalio/worker`](https://www.npmjs.com/package/@temporalio/worker)                                         |
| [`packages/workflow/`](packages/workflow/)                                     | [`@temporalio/workflow`](https://www.npmjs.com/package/@temporalio/workflow)                                     |
| [`packages/activity/`](packages/activity/)                                     | [`@temporalio/activity`](https://www.npmjs.com/package/@temporalio/activity)                                     |
| [`packages/testing/`](packages/testing/)                                       | [`@temporalio/testing`](https://www.npmjs.com/package/@temporalio/testing)                                       |
| [`packages/common/`](packages/common/)                                         | [`@temporalio/common`](https://www.npmjs.com/package/@temporalio/common)                                         |
| [`packages/proto/`](packages/proto/)                                           | [`@temporalio/proto`](https://www.npmjs.com/package/@temporalio/proto)                                           |
| [`packages/interceptors-opentelemetry/`](packages/interceptors-opentelemetry/) | [`@temporalio/interceptors-opentelemetry`](https://www.npmjs.com/package/@temporalio/interceptors-opentelemetry) |
| [`packages/test/`](packages/test/)                                             | SDK internal tests                                                                                               |
| [`packages/create-project/`](packages/create-project/)                         | [`@temporalio/create`](https://www.npmjs.com/package/@temporalio/create-project)                                 |
| [`packages/docs/`](packages/docs/)                                             | [API docs](https://typescript.temporal.io/)                                                                      |
| [`packages/core-bridge/`](packages/core-bridge/)                               | [`@temporalio/core-bridge`](https://www.npmjs.com/package/@temporalio/proto)                                     |
| [`packages/envconfig/`](packages/envconfig/)                                   | [`@temporalio/envconfig`](https://www.npmjs.com/package/@temporalio/envconfig)                                   |
| [`packages/nyc-test-coverage/`](packages/nyc-test-coverage/)                   | [`@temporalio/nyc-test-coverage`](https://www.npmjs.com/package/@temporalio/nyc-test-coverage)                   |
| [`packages/plugin/`](packages/plugin/)                                         | [`@temporalio/plugin`](https://www.npmjs.com/package/@temporalio/plugin)                                         |
| [`packages/nexus/`](packages/nexus/)                                           | [`@temporalio/nexus`](https://www.npmjs.com/package/@temporalio/nexus)                                           |

## Contributing

We welcome issues and pull requests!

Please read our [contributing guide](CONTRIBUTING.md) to learn about our
development process, and how to propose bugfixes and improvements.

Thank you to [everyone who has contributed](https://github.com/temporalio/sdk-typescript/graphs/contributors) to the Temporal TypeScript SDK 😃🙌
