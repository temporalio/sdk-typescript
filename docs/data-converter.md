When designing the custom data converter feature, we considered two routes:

- Doing conversion outside of Workflow vm
- Doing conversion inside and outside of Workflow vm

### Outside vm

- Pro: Users can use any node module in their custom data converter code.
- Pro: Methods can be async (users can use Promises).
- Con: Only works because `vm` allows for passing complex objects into/out of vm. If we switch to an isolation method like `isolated-vm` or `rusty_v8`, conversion needs to be done inside.
- Con: `object instanceof Class` doesn't work on object that come from the vm, because the `Class` definition inside the vm is from a different instance of the code. A workaround like this must be used:

```ts
function workflowInclusiveInstanceOf(instance: unknown, type: Function): boolean {
  let proto = Object.getPrototypeOf(instance);
  while (proto) {
    if (proto.constructor?.toString() === type.toString()) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}
```

## Decision

Given the possibility of switching or adding other isolation methods in future, we opted to convert to/from Payloads inside the vm (`PayloadConverter`). We also added another transformer layer called `PayloadCodec` that runs outside the vm, can use node modules and Promises, and operates on Payloads. A `DataConverter` is a `PayloadConverter` and a `PayloadCodec`:

```ts
export interface DataConverter {
  payloadConverterPath?: string;
  payloadCodec?: PayloadCodec;
}

export interface PayloadConverter {
  toPayload<T>(value: T): Payload;
  fromPayload<T>(payload: Payload): T;
}

export interface PayloadCodec {
  encode(payloads: Payload[]): Promise<Payload[]>;
  decode(payloads: Payload[]): Promise<Payload[]>;
}
```

### Worker converter flow

`PayloadCodec` only runs in the main thread.

When `WorkerOptions.dataConverter.payloadConverterPath` is provided, the code at that location is loaded into the main thread, the worker threads, and the webpack Workflow bundle.

`Worker.create`:
_main thread_

- imports and validates `options.dataConverter.payloadConverterPath`
- passes `payloadConverterPath` to `WorkflowCodeBundler`

Execution goes to either:

- `ThreadedVMWorkflowCreator.create`
  _main thread_

- `VMWorkflowCreator.create`
  _worker thread (unless in debug mode)_

And then to:

- `VMWorkflowCreator.createWorkflow`
  _worker thread (unless in debug mode)_

And then to:

`worker-interface.ts#initRuntime`:
_workflow vm_

- Imports `__temporal_custom_payload_converter`, which will either be the code bundled from `payloadConverterPath` or `undefined`. If it's defined, sets `state.payloadConverter`.
