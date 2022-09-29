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

Given the possibility of switching or adding other isolation methods in future, we opted to convert to/from Payloads inside the vm (`PayloadConverter`). We also added another transformer layer called `PayloadCodec` that runs outside the vm, can use node async APIs (like `zlib.gzip` for compression or `crypto.scrypt` for encryption), and operates on Payloads. A `DataConverter` is a `PayloadConverter` and zero or more `PayloadCodec`s:

Later on (2022-09-22) we added a `FailureConverter` that is responsible to convert from proto `Failure` instances to JS
`Error`s and back. The failure converter runs inside the Workflow vm and may place failure attributes in the
[`Failure.encoded_attributes`][encoded_attributes] `Payload`. If that payload is present, it will be encoded / decoded
with the configured set of `PayloadCodec`s.

The SDK contains a "default" `FailureConverter` that can be configured to encode error messages and stack traces.

```ts
export interface DataConverter {
  payloadConverterPath?: string;
  failureConverterPath?: string;
  payloadCodecs?: PayloadCodec[];
}

export interface PayloadConverter {
  toPayload<T>(value: T): Payload | undefined;
  fromPayload<T>(payload: Payload): T;
}

export interface FailureConverter {
  errorToFailure(err: unknown): ProtoFailure;
  failureToError(err: ProtoFailure): TemporalFailure;
}

export interface PayloadCodec {
  encode(payloads: Payload[]): Promise<Payload[]>;
  decode(payloads: Payload[]): Promise<Payload[]>;
}
```

`PayloadCodec` is an optional step that happens between the wire and the `PayloadConverter`:

Temporal Server <--> Wire <--> `PayloadCodec` <--> `PayloadConverter` <--> User code

### Worker converter flow

`PayloadCodec` only runs in the main thread.

When `WorkerOptions.dataConverter.payloadConverterPath` (or `failureConverterPath`) is provided, the code at that
location is loaded into the main thread and the webpack Workflow bundle.

`Worker.create`:
_main thread_

- imports and validates `options.dataConverter.payloadConverterPath`
- imports and validates `options.dataConverter.failureConverterPath`
- passes `payloadConverterPath` to `WorkflowCodeBundler`

`worker-interface.ts#initRuntime`:
_workflow vm_

- Imports `__temporal_custom_payload_converter`, which will either be the code bundled from `payloadConverterPath` or
  `undefined`. If it's defined, sets `state.payloadConverter`.
- Imports `__temporal_custom_failure_converter`, which will either be the code bundled from `failureConverterPath` or
  `undefined`. If it's defined, sets `state.failureConverter`.

[encoded_attributes]: https://github.com/temporalio/api/blob/ddf07ab9933e8230309850e3c579e1ff34b03f53/temporal/api/failure/v1/message.proto#L102
