### Scopes and Cancellation

Temporal workflows have different types that can be cancelled:

- A timer or an activity
- An entire workflow
- A workflow scope

Workflows are represented internally by a tree of scopes where the `main` function runs in the root scope.
Cancellation propagates from outer scopes to inner ones and is handled by catching `CancellationError`s when `await`ing on `Promise`s.
Each activity and timer implicitly creates a new scope to support cancellation.

The following example demonstrates how to handle workflow cancellation by an external client while an activity is running.

```ts
import { CancellationError } from '@temporal-sdk/workflow';
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

Scopes may be cancelled from workflow code using `cancel`.

```ts
import { CancellationError, cancel, sleep } from '@temporal-sdk/workflow';

export async function main() {
  // Timers and activities are automatically cancelled when their scope is cancelled.
  // Awaiting on a cancelled scope with throw the original CancellationError.
  const scope = sleep(1);
  cancel(scope);
  try {
    await scope;
  } catch (e) {
    if (e instanceof CancellationError) {
      console.log('Exception was propagated 👍');
    }
  }
}
```

In order to have fine-grained control over cancellation, the workflow library exports 2 methods for explicitly creating scopes.

The first is `cancellationScope` which when cancelled will propagate cancellation to all child scopes such as timers, activities and other scopes.

```ts
import { CancellationError, cancellationScope, cancel, sleep } from '@temporal-sdk/workflow';
import { httpGetJSON } from '@activities';

export async function main(urls: string[], timeoutMs: number) {
  const scope = cancellationScope(async () => {
    return Promise.all(urls.map(httpGetJSON));
  });
  try {
    const results = await Promise.race([
      scope,
      sleep(timeoutMs).then(() => {
        cancel(scope);
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

The second is `shield` which prevents cancellation from propagating to child scopes.
Note that by default it still throws `CancellationError` to be handled by waiters.

```ts
import { CancellationError, shield } from '@temporal-sdk/workflow';
import { httpGetJSON } from '@activities';

export async function main(url: string) {
  let result: any = undefined;
  try {
    // Shield and await completion unless cancelled
    result = await shield(async () => httpGetJSON(url));
  } catch (e) {
    if (e instanceof CancellationError) {
      console.log('Exception was propagated 👍');
    }
  }
  return result; // Could be undefined
}
```

In case the result of the shielded activity is needed despite the cancellation, pass `false` as the second argument to `shield` (`throwOnCancellation`).
To see if the workflow was cancelled while waiting, check `Context.cancelled`.

```ts
import { Context, CancellationError, shield } from '@temporal-sdk/workflow';
import { httpGetJSON } from '@activities';

export async function main(url: string) {
  const result = await shield(async () => httpGetJSON(url), false);
  if (Context.cancelled) {
    console.log('Workflow cancelled');
  }
  return result;
}
```

More complex flows may be achieved by nesting `cancellationScope`s and `shield`s.
