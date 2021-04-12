# Temporal NodeJS SDK

![CI](https://github.com/temporalio/sdk-node/actions/workflows/ci.yml/badge.svg)
[![NPM](https://img.shields.io/npm/v/temporalio.svg?style=flat)](https://www.npmjs.com/package/temporalio)

Typescript + NodeJS SDK for [Temporal](temporal.io).

## !!! This is a work in progress, not ready for use yet !!!

For more information see the [proposal](https://github.com/temporalio/proposals/blob/master/node/node-sdk.md).

<!-- vim-markdown-toc GFM -->

- [Getting started](#getting-started)
  - [Install system dependencies](#install-system-dependencies)
  - [Create a new project](#create-a-new-project)
  - [Compile Typescript](#compile-typescript)
  - [Run the Temporal server](#run-the-temporal-server)
  - [Test your workflow](#test-your-workflow)
- [Hello World](#hello-world)
  - [Activities and workflows](#activities-and-workflows)
  - [Worker and client](#worker-and-client)
- [Sub Packages](#sub-packages)
- [Logging](#logging)
- [Development](#development)
  - [Environment set up](#environment-set-up)
  - [Building](#building)
  - [Rebuilding (useful for after deleting Typescript files)](#rebuilding-useful-for-after-deleting-typescript-files)
  - [Building with watch (Typescript only)](#building-with-watch-typescript-only)
  - [Testing](#testing)
    - [Integration tests](#integration-tests)

<!-- vim-markdown-toc -->

### Getting started

#### Install system dependencies

This project requires nodejs LTS version 12 (or later).

Furthermore, to install, you will need a c++ compiler.
If you run into errors during installation it is likely your environment is not properly set up.

The worker package embeds the Temporal Core SDK which requires the Rust toolchain to compile.
We provided prebuilt binaries for the worker for:

- Mac with an Intel chip: `x86_64-apple-darwin`
- Mac with an M1 chip: `aarch64-apple-darwin`
- Linux with x86_64 architecture: `x86_64-unknown-linux-gnu`
- Windows with x86_64 architecture: `x86_64-pc-windows-gnu`

- If you need to compile the worker yourself, set up the Rust toolchain by following the instructions [here](https://rustup.rs/).
- To set up a C++ compiler for `node-gyp`, follow the instuctions [here](https://github.com/nodejs/node-gyp)

#### Create a new project

Use the [project initializer](../create-project/README.md) to create a new project.

```sh
npm init @temporalio ./example
cd ./example
```

> NOTE: `init` triggers native module compilation which might take a while, npm 7 hides the compilation output so it may appear that the installation is stuck, to see the compilation progress export `NPM_CONFIG_FOREGROUND_SCRIPTS=true`.

#### Compile Typescript

```
npm run build
```

#### Run the Temporal server

Download, install, and run the [Temporal server](https://docs.temporal.io/docs/server-quick-install) via docker-compose. It is easy to do and you can keep it running in the background while you build applications.

#### Test your workflow

- Run the worker

  ```sh
  node lib/worker/index.js
  ```

- Run the workflow

  ```sh
  node lib/worker/test.js
  ```

### Hello World

#### Activities and workflows

`src/activities/greeter.ts`

```ts
// Activities are just async functions
export async function greet(name: string): Promise<string> {
  return `Hello, ${name}!`;
}
```

`src/interfaces/workflows.ts`

```ts
import { Workflow } from '@temporalio/workflow';

// Extend the generic Workflow interface to check that Example is a valid workflow interface
// Workflow interfaces are useful for generating type safe workflow clients
export interface Example extends Workflow {
  main(name: string): Promise<string>;
}
```

`src/workflows/example.ts`

```ts
import { Example } from '@interfaces/workflows';
import { greet } from '@activities/greeter';

// A workflow that simply calls an activity
async function main(name: string): Promise<string> {
  return greet(name);
}

// Declare the workflow's type to be checked by the Typescript compiler
export const workflow: Example = { main };
```

#### Worker and client

`src/worker/index.ts`

```ts
import { Worker } from '@temporalio/worker';

(async () => {
  // Automatically locate and register activities and workflows
  // (assuming package was bootstrapped with `npm init @temporalio`).
  // Worker connects to localhost by default and uses console error for logging.
  // Customize the worker by passing options a second parameter of `create()`.
  const worker = await Worker.create(__dirname);
  // Bind to the `tutorial` queue and start accepting tasks
  await worker.run('tutorial');
})();
```

`src/worker/test.ts`

```ts
import { Connection } from '@temporalio/client';
import { Example } from '@interfaces/workflows';

(async () => {
  // Connect to localhost and use the "default" namespace
  const connection = new Connection();
  // Create a typed client for the workflow defined above
  const example = connection.workflow<Example>('example', { taskQueue: 'tutorial' });
  const result = await example.start('Temporal');
  console.log(result); // Hello, Temporal
})();
```

### Sub Packages

This project is effectively a mono-repo consisting of several packages, the public packages are listed below.

The repo is managed with [`lerna`](https://lerna.js.org/).

- [`temporalio`](./packages/meta/) - The meta package, installs the worker, client, activity, and workflow packages.
- [`@temporalio/worker`](./packages/worker/) - Communicates with the Temporal service and runs workflows and activities
- [`@temporalio/workflow`](./packages/workflow/) - Utilities for authoring workflows
- [`@temporalio/activity`](./packages/activity/) - Utilities for authoring activites
- [`@temporalio/client`](./packages/client/) - Communicate with the Temporal service for things like administration and scheduling workflows
- [`@temporalio/proto`](./packages/proto/) - Compiled protobuf definitions
- [`@temporalio/create`](./packages/create-project/) - NPM project initializer

### Logging

See [docs](docs/logging.md)

### Development

#### Environment set up

```sh
git submodule init
git submodule update
npm ci
```

#### Building

```sh
npm run build
```

#### Rebuilding (useful for after deleting Typescript files)

```sh
npm run rebuild
```

#### Building with watch (Typescript only)

```sh
npm run build  # Must be run once before build.watch
npm run build.watch
```

#### Testing

```sh
npm run test
```

-- OR --

```sh
npm run test.watch
```

##### Integration tests

In order to run integration tests:

1. Run the temporal server using [docker-compose](https://github.com/temporalio/docker-compose).
1. Export `RUN_INTEGRATION_TESTS=true`
