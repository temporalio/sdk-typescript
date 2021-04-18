# Temporal NodeJS SDK

![CI](https://github.com/temporalio/sdk-node/actions/workflows/ci.yml/badge.svg)
[![NPM](https://img.shields.io/npm/v/temporalio.svg?style=flat)](https://www.npmjs.com/package/temporalio)

Typescript + NodeJS SDK for [Temporal](temporal.io).

## !!! This is a work in progress, not ready for use yet !!!

> NOTE: This SDK is in alpha stage, API is considered unstable and may change at any time.
> While in alpha we plan on gathering feedback from developers about their experience with the SDK.
> To provide feedback please [open an issue](https://github.com/temporalio/sdk-node/issues).

For more information see the [Temporal docs site](https://docs.temporal.io/) and the [NodeJS SDK proposal](https://github.com/temporalio/proposals/blob/master/node/node-sdk.md).

<!-- vim-markdown-toc GFM -->

- [Getting started](#getting-started)
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

### [Getting started](https://docs.temporalio/docs/node/getting-started)

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
