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

Given the possibility of switching or adding other isolation methods in future, we opted for inside the vm. We'll also have another data transformer / payload interceptor layer that runs outside the vm, can use node modules and Promises, and operates on Payloads.

### General flow

When `WorkerOptions.dataConverterPath` is provided, the code at that location is loaded into the main thread, the worker threads, and the webpack Workflow bundle.

### Specific flow

Worker main thread:

- imports and validates `dataConverterPath`
- passes `dataConverterPath` to either `ThreadedVMWorkflowCreator.create` or `VMWorkflowCreator.create`
- passes `dataConverterPath` to `WorkflowCodeBundler`

`ThreadedVMWorkflowCreator.create`:

- sends `dataConverterPath` to each worker thread
- thread sends `dataConverterPath` to VMWorkflowCreator.create

`VMWorkflowCreator.create`:
(This is usually running in a worker thread, but in debug mode is running in the main thread)

- imports `dataConverterPath`
- passes `dataConverterPath` to `VMWorkflowCreator` constructor

`VMWorkflowCreator.createWorkflow`:

- passes `useCustomDataConverter` to `initRuntime` inside Workflow vm

`worker-interface.ts#initRuntime`:
(Inside vm)

- if `useCustomDataConverter`, imports `__temporal_custom_data_converter` and sets `state.dataConverter`
