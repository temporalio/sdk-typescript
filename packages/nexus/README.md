# `@temporalio/nexus`

[![NPM](https://img.shields.io/npm/v/@temporalio/nexus?style=for-the-badge)](https://www.npmjs.com/package/@temporalio/nexus)

Part of [Temporal](https://temporal.io)'s [TypeScript SDK](https://docs.temporal.io/typescript/introduction/).

- [API reference](https://typescript.temporal.io/api/namespaces/nexus)
- [Sample projects](https://github.com/temporalio/samples-typescript)

## Implementing a Temporal-backed operation

Pass a `start(client, input)` function to `TemporalOperationHandler`. Use
`TemporalOperationResult.sync(output)` to complete synchronously, or return the result of a
Temporal Client helper such as `client.startWorkflow(...)` to complete asynchronously.

```ts
import { operationInfo, TemporalOperationHandler, TemporalOperationResult } from '@temporalio/nexus';
import { operation, service, serviceHandler } from 'nexus-rpc';

const greetings = service('greetings', { greet: operation<string, string>() });

export const greetingsHandler = serviceHandler(greetings, {
  greet: new TemporalOperationHandler({
    async start(_client, name) {
      operationInfo().cancellationSignal.throwIfAborted();
      return TemporalOperationResult.sync(`Hello, ${name}!`);
    },
  }),
});
```

Register `greetingsHandler` in the Worker's `nexusServices`. Use `operationInfo()` inside a handler
for the service, operation, and start request ID. A start retry carries the same opaque request ID.
Custom cancel callbacks receive their typed options, and `operationInfo().requestId` is undefined
in a cancel callback. The cancellation signal tracks the current handler invocation. Use a Worker
Nexus interceptor to read request headers.
