# Experimental VM-less workflow execution

The opt-in VM-less executor evaluates a workflow bundle in a dedicated workflow
thread, without Node's VM API. VM execution remains the default.

This is an unsafe execution experiment, not an alternative sandbox. It does not
and will never offer safety equivalent to VM execution.

## Usage

For automatic bundling:

```ts
const worker = await Worker.create({
  taskQueue: 'prototype',
  workflowsPath: require.resolve('./workflows'),
  workflowExecutionMode: 'vmless',
  activities,
});
await worker.run();
```

For prebuilt artifacts, select the same mode at bundle creation and execution:

```ts
const workflowBundle = await bundleWorkflowCode({
  workflowsPath: require.resolve('./workflows'),
  workflowExecutionMode: 'vmless',
});
const worker = await Worker.create({
  taskQueue: 'prototype',
  workflowBundle,
  workflowExecutionMode: 'vmless',
  activities,
});
```

Replay also accepts `workflowExecutionMode: 'vmless'`, with either `workflowsPath`
or a matching prebuilt bundle. Bundles carry a mode marker; a VM-less artifact
cannot be used with a VM executor or vice versa. Existing VM artifacts remain
valid and do not need an explicit mode marker.

The option is experimental and requires one workflow thread. Runtime identity is
not rejected up front; compatibility is established through tests.
Do not set `reuseV8Context`, `showStackTraceSources`, or the internal
`isolateExecutionTimeout` control. `debugMode: true`, `TEMPORAL_DEBUG=true`,
nonempty `bundlerOptions.preloadModules`, and thread-pool sizes other than one are
rejected. Workflows do not execute on the Worker's main thread.

## Execution model

The bundle is evaluated once per workflow thread. SDK infrastructure is shared;
application workflows, interceptors, and converters use per-execution module
caches. Their module initialization runs under the owning execution. Async-local
storage maintains ownership through continuations and workflow scopes.

Currently the shared cache contains modules reached while importing the VM-less
runtime and `@temporalio/workflow` during bootstrap. It is a reachability-based
partition, not a declared SDK/application module boundary. A new transitive import
or a lazily loaded SDK entry point can change which cache holds a module; making
that sharing boundary explicit remains an architectural review concern.

That module cache is not realm isolation. Globals and built-in prototypes are
shared and are not frozen. Application code can corrupt other executions or the
thread itself. Supporting multiple Workers in one process, including mixed
execution modes, is outside this experiment's scope.

Workflow-aware Date, randomness, global timers, and console dispatch preserve
useful workflow semantics. Existing bundle import restrictions remain in place,
but are not security controls. This is not comprehensive interception of Node
APIs, and ordinary Node application module loading is not supported.

Activation processing uses native event-loop checkpoints and condition evaluation
instead of VM evaluation checkpoints. These permit finite promise chains to
settle, but also permit native callbacks to run. Arbitrary native asynchronous
operations can outlive an activation or eviction; they are unsupported. Disposed
execution context is invalidated, not converted into host context.

The VM-less runtime explicitly observes the final SDK-owned promise chains for
workflow execution, signals, and updates. Errors escaping those chains are
recorded on their owning execution as workflow-task errors, after handler cleanup,
without invoking converters or rethrowing from the observer. Normal workflow and
update failures still follow their existing handling. Promises returned to
application code are not individually observed by this mechanism, so application
code can still catch activity failures and cancellation normally.

Genuinely unhandled rejections are fatal to the workflow thread, including those
from detached application work or callbacks after disposal. There is no
per-workflow attribution for those errors, and all executions in the thread are
affected. This policy does not require V8 promise hooks. Disposal releases
execution-owned SDK resources but cannot cancel arbitrary native resources.

The SDK-owned error tests and live execution/replay pass on Bun 1.4.0. Remaining
Bun test failures include exact source-map locations and delayed detached
rejections triggered between activations or after disposal, where the process
exits normally instead of reporting a fatal error. These assertions remain
enabled; this is not a claim of complete Bun compatibility.

There is no synchronous execution timeout. A busy loop or infinite microtask chain
can hang the workflow thread, including activation and shutdown. Condition draining
continues until no conditions unblock.

No universal replay compatibility with VM-produced histories is promised.
