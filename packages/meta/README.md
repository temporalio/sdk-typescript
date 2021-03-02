# Temporal NodeJS SDK

![CI](https://github.com/temporalio/sdk-node/actions/workflows/ci.yml/badge.svg)

Typescript + NodeJS SDK for [Temporal](temporal.io).

## !!! This is a work in progress, not ready for use yet !!!

For more information see the [proposal](https://github.com/temporalio/proposals/blob/master/node/node-sdk.md).

<!-- vim-markdown-toc GFM -->

- [Getting started](#getting-started)
  - [Install system dependencies](#install-system-dependencies)
  - [Create a new project](#create-a-new-project)
  - [Build everything](#build-everything)
  - [Run the Temporal server](#run-the-temporal-server)
  - [Test your workflow](#test-your-workflow)
- [Hello World](#hello-world)
  - [Activities and workflows](#activities-and-workflows)
  - [Worker and client](#worker-and-client)
- [Development](#development)
  - [Environment set up](#environment-set-up)
  - [Building](#building)
  - [Building with watch](#building-with-watch)
  - [Testing](#testing)

<!-- vim-markdown-toc -->

### Getting started

> Not working yet, activities not implemented

#### Install system dependencies

This project requires nodejs LTS version 12 (or later).

Furthermore, to install this module you will need a c++ compiler and the Rust toolchain installed.
If you run into errors during installation it is likely your environment is not properly set up.

- To set up a C++ compiler for `node-gyp`, follow the instuctions [here](https://github.com/nodejs/node-gyp)
- To set up the Rust toolchain, follow the instruction [here](https://rustup.rs/)

#### Create a new project

```sh
npm init @temporalio ./example
cd ./example
```

#### Build everything

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
export async function greet(name: string): Promise<string> {
  return `Hello, ${name}!`;
}
```

`src/interfaces/workflows.ts`

```ts
import { Workflow } from '@temporalio/workflow';

export interface Example extends Workflow {
  main(name: string): Promise<string>;
}
```

`src/workflows/example.ts`

```ts
import { Example } from '@interfaces/workflows';
import { greet } from '@activities/greeter';

async function main(name: string): Promise<string> {
  return await greet(name);
}

export const workflow: Example = { main };
```

#### Worker and client

`src/worker/index.ts`

```ts
import { Worker } from '@temporalio/worker';

(async () => {
  // Automatically locate and register activities and workflows
  const worker = new Worker(__dirname);
  // Bind to the `tutorial` queue and start accepting tasks
  await worker.run('tutorial');
})();
```

`src/worker/test.ts`

```ts
import { Connection } from '@temporalio/client';
import { Example } from '@interfaces/workflows';

(async () => {
  const connection = new Connection();
  const example = connection.workflow<Example>('example', { taskQueue: 'tutorial' });
  const result = await example('Temporal');
  console.log(result); // Hello, Temporal
})();
```

### Development

#### Environment set up

```sh
git submodule init
git submodule update
npm ci
```

#### Building

```sh
npm run clean
npm run build
```

#### Building with watch

```sh
npm run clean
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
