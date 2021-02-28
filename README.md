# Temporal NodeJS SDK

![CI](https://github.com/temporalio/sdk-node/actions/workflows/ci.yml/badge.svg)

Typescript + NodeJS SDK for [Temporal](temporal.io).

## !!! This is a work in progress, not ready for use yet !!!

For more information see the [proposal](https://github.com/temporalio/proposals/blob/master/node/node-sdk.md).

### Getting started

> Not working yet, activities not implemented

#### Create a new project

```sh
npm init @temporalio ./example
cd example
```

#### Create activities and workflows

`activities/greeter.ts`

```ts
export async function greet(name: string): Promise<string> {
  return `Hello, ${name}!`;
}
```

`interfaces/workflows.ts`

```ts
import { Workflow } from '@temporal-sdk/interfaces';

export interface Example extends Workflow {
  main(name: string): Promise<string>;
}
```

`workflows/example.ts`

```ts
import { Example } from '@interfaces/workflows';
import { greet } from '@activities/greeter';

async function main(name: string): Promise<string> {
  return await greet(name);
}

export const workflow: Example = { main };
```

#### Create worker and client

`worker/index.ts`

```ts
import { Worker } from '@temporalio/worker';

(async () => {
  // Automatically locate and register activities and workflows
  const worker = new Worker(__dirname);
  // Bind to the `tutorial` queue and start accepting tasks
  await worker.run('tutorial');
})();
```

`worker/test.ts`

```ts
import { Example } from '@interfaces/workflows';
import { Connection } from '@temporalio/client';

(async () => {
  const connection = new Connection();
  const example = connection.workflow<Example>('example', { taskQueue: 'tutorial' });
  const result = await example('Temporal');
  console.log(result); // Hello, Temporal
})();
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
