### Scopes and Cancellation

Temporal workflows have different types that can be cancelled:
* A timer or an activity
* An entire workflow
* A workflow scope

Workflows are represented internally by a tree of scopes where the `main` function runs in the root scope.
Cancellation propagates from outer scopes to inner ones and is handled by catching `CancellationError`s when `await`ing on `Promise`s.
Each activity and timer implicitly creates a new scope to support cancellation.

The following example demonstrates how to handle workflow cancellation by an external client while an activity is running.

```ts
import { Context, CancellationError } from '@temporal-sdk/workflow';
import { httpGetJSON } from '@activities';

export async function main(url: string) {
  let result: any = undefined;
  try {
    result = await httpGetJSON(url);
  } catch (e) {
    if (e instanceof CancellationError) {
      console.log('Workflow cancelled');
    } else {
      throw e;
    }
  }
  return result;
}
```

Scopes may be cancelled from workflow code using `Context.cancel`.

```ts
import { Context, CancellationError, sleep } from '@temporal-sdk/workflow';

export async function main() {
  // Timers and activities are automatically cancelled when their scope is cancelled.
  // Awaiting on a cancelled scope with throw the original CancellationError.
  const scope = sleep(1);
  Context.cancel(scope);
  try {
    await child;
  } catch (e) {
    if (e instanceof CancellationError) {
      console.log('Exception was propagated 👍');
    }
  }
}
```

In order to have fine-grained control over cancellation, the workflow's `Context` exposes 2 methods for explicitly creating scopes.

The first is `Context.scope` which when cancelled will propagate cancellation to all child scopes such as timers, activities and other scopes.
```ts
import { Context, CancellationError, sleep } from '@temporal-sdk/workflow';
import { httpGetJSON } from '@activities';

export async function main(urls: string[], timeoutMs: number) {
  const scope = Context.scope(async () => {
    return Promise.all(urls.map(httpGetJSON));
  });
  try {
    const results = await Promise.race([
      scope,
      sleep(timeoutMs).then(() => {
        Context.cancel(scope);
        // CancellationError rejects the race via scope
        // Any code below this line may still run
      }),
    ]);
    // Do something with the results
  } catch (e) {
    if (e instanceof CancellationError) {
      console.log('Exception was propagated 👍');
    }
  }
}
```

The second is `Context.shield` which prevents cancellation from propagating to child scopes.
Note that it still throws `CancellationError` to be handled by waiters.

```ts
import { Context, CancellationError } from '@temporal-sdk/workflow';
import { httpGetJSON } from '@activities';

export async function main(url: string) {
  let result: any = undefined;
  try {
    // Shield and await completion unless cancelled
    result = await Context.shield(async () => {
      await httpGetJSON(url);
    });
  } catch (e) {
    if (e instanceof CancellationError) {
      console.log('Exception was propagated 👍');
    }
  }
  return result; // Could be undefined
}
```

In case the result of the shielded activity is needed despite the cancellation, the shielded `Promise` should be stored in a variable to be awaited later.

```ts
import { Context, CancellationError } from '@temporal-sdk/workflow';
import { httpGetJSON } from '@activities';

export async function main(url: string) {
  let shielded: Promise<any> | undefined;
  try {
    result = await Context.shield(async () => {
      shielded = httpGetJSON(url);
      return await shielded;
    });
  } catch (e) {
    // We still want to know the workflow was cancelled
    if (e instanceof CancellationError) {
      console.log('Workflow cancelled');
      try {
        result = await shielded;
      } catch (e) {
        // handle activity failed
      }
    } else {
      throw e;
    }
  }
  return result;
}
```

More complex flows may be achieved by nesting `Context.scope`s and `Context.shield`s.
