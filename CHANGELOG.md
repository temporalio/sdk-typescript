# Changelog

All notable changes to this project will be documented in this file.

Breaking changes marked with a :boom:

## [0.12.0] - 2021-10-25

### Bug Fixes

- [`workflow`] Validate timer duration is positive ([#328](https://github.com/temporalio/sdk-typescript/pull/328))
- [`worker`] Provide better error messages when instantiating rust Core ([#331](https://github.com/temporalio/sdk-typescript/pull/331))

### Features

- :boom: Restructure code in prep for vm transition ([#317](https://github.com/temporalio/sdk-typescript/pull/317))

  - Decrease Workflow bundle size from ~7.44MB to ~2.75MB
  - :boom: Remove otel module from @temporalio/common default export
  - Rename WorkflowIsolateBuilder to WorkflowCodeBundler and remove unused methods
  - Add Workflow and WorkflowCreator interfaces to support pluggable workflow environments (prepare for VM)
  - :boom: Simplify external dependencies mechanism to only support void functions and remove the isolated-vm transfer options.

- Support [`ms`](https://www.npmjs.com/package/ms) formatted string for activity.Context.sleep ([#322](https://github.com/temporalio/sdk-typescript/pull/322))
- :boom: Runtime determinism tweaks ([#326](https://github.com/temporalio/sdk-typescript/pull/326))
  - Undelete WeakMap and WeakSet
  - Delete FinalizationRegistry

### Miscellaneous Tasks

- Change client name string to `temporal-typescript` ([#306](https://github.com/temporalio/sdk-typescript/pull/306))
- Rename to sdk-typescript ([#320](https://github.com/temporalio/sdk-typescript/pull/320))

### Testing

- Print more useful information in load test ([#315](https://github.com/temporalio/sdk-typescript/pull/315))

## [0.11.1] - 2021-10-15

### Bug Fixes

- [`proto`] Remove core-bridge dependency from proto package ([#295](https://github.com/temporalio/sdk-typescript/pull/295))
- Indefinitely reconnect to server on poll errors ([#298](https://github.com/temporalio/sdk-typescript/pull/298))
- WorkflowHandle.signal() can take a string, default args to [] ([#297](https://github.com/temporalio/sdk-typescript/pull/297))
- Poll for Activities even if none registered ([#300](https://github.com/temporalio/sdk-typescript/pull/300))
- Delay query processing until workflow has started ([#301](https://github.com/temporalio/sdk-typescript/pull/301))
- Shutdown native worker on webpack errors and provide better error message ([#302](https://github.com/temporalio/sdk-typescript/pull/302))

### Features

- Support ES Module based projects ([#303](https://github.com/temporalio/sdk-typescript/pull/303))

### Documentation

- Add more links in per-package READMEs for NPM ([#296](https://github.com/temporalio/sdk-typescript/pull/296))

### Testing

- Add nightly "load sampler" run ([#281](https://github.com/temporalio/sdk-typescript/pull/281))
- Add smorgasbord workflow
- Address smorgasboard wf feedback
- Test init from fetch-esm sample

## [0.11.0] - 2021-10-12

### Bug Fixes

- [`workflow`] Export ChildWorkflowOptions and ParentClosePolicy
- Don't set default workflowIdReusePolicy
- Allow getting Date in Workflow top level

### Features

- [`client`] Add gRPC retry interceptors
- Enhance `@temporalio/create` and use samples-node as its source ([#273](https://github.com/temporalio/sdk-typescript/pull/273))
- :boom:[`core`] Change `WARNING` log level to `WARN`
- Add Core option to forward logs from Rust to configurable Node logger
- [`workflow`] Support `ms` formatted strings in sleep() function
- :boom:[`worker`] Remove `workDir` Worker option

  Activities and Workflows are not automatically detected
  anymore. `nodeModulesPath` has been renamed `nodeModulesPaths` to
  support resolution from multiple `node_modules` paths, the Worker will
  attempt to autodiscover `node_modules` based on provided
  `workflowsPath`.

- [`workflow`] Provide better error message when calling createChildWorkflowHandle on unregistered workflow
- :boom:[`client`] Switch parameter order in WorkflowClient.execute and start methods
- [`workflow`] Add condition helper function
- Link Node / Core and `interceptors/opentelemetry` generated spans together
- :boom:[`workflow`] Implement Workflow API 3rd revision ([#292](https://github.com/temporalio/sdk-typescript/pull/292))

  All existing Workflows need to be rewritten in the new form:

  ```ts
  import * as wf from '@temporalio/workflow';

  export const unblockSignal = wf.defineSignal('unblock');
  export const isBlockedQuery = wf.defineQuery<boolean>('isBlocked');

  export async function myWorkflow(arg1: number, arg2: string): Promise<void> {
    let isBlocked = true;
    wf.setListener(unblockSignal, () => void (isBlocked = false));
    wf.setListener(isBlockedQuery, () => isBlocked);
    await wf.condition(() => !isBlocked);
  }
  ```

  See the [proposal](https://github.com/temporalio/proposals/pull/44) for more information.

### Miscellaneous Tasks

- Remove port bindings from buildkite docker compose file
- Remove unneeded bit of protection around shutdown now that core handles it
- Reuse loaded package.json for ServerOptions.sdkVersion
- Initial nightly long run implementation
- Print error with traceback when promise hook fails
- Pass client/version info to core, work with new options builders
- Properly set otel context when calling into core
- Handle scenario where worker is totally removed before calling next poll
- Don't log empty metadata

### Documentation

- Fix double heartbeat() docstring
