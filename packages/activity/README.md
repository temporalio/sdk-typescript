# `@temporalio/activity`

[![NPM](https://img.shields.io/npm/v/@temporalio/activity)](https://www.npmjs.com/package/@temporalio/activity)

Part of the [Temporal](https://temporal.io) [NodeJS SDK](https://www.npmjs.com/package/temporalio).

This library provides tools required for writing activities and should only be imported in activity code.

### Usage

`src/activities/index.ts`

```ts
import fetch from 'node-fetch';
import { Context, CancellationError } from '@temporalio/activity';

// An activity that fakes progress and can be cancelled
export async function fakeProgress(): Promise<void> {
  try {
    for (let progress = 1; progress <= 100; ++progress) {
      const timer = new Promise((resolve) => setTimeout(resolve, 1000));
      // sleep for 1 second or throw if activity is cancelled
      await Promise.race([Context.current().cancelled, timer]);
      Context.current().heartbeat(progress);
    }
  } catch (err) {
    if (err instanceof CancellationError) {
      // Cleanup
    }
    throw err;
  }
}

// An activity that makes a cancellable HTTP request
export async function cancellableFetch(url: string): Promise<any> {
  const response = await fetch(url, { signal: Context.current().cancellationSignal });
  return response.json();
}
```
