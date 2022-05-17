# Changelog

All notable changes to this project will be documented in this file.

Breaking changes marked with a :boom:

## [0.23.2] - 2022-05-17

### Miscellaneous Tasks

- Publish missing `@temporalio/testing` scripts ([#653](https://github.com/temporalio/sdk-typescript/pull/653))

## [0.23.1] - 2022-05-16

### Bug Fixes

- [`worker`] Fix memory leaks ([#651](https://github.com/temporalio/sdk-typescript/pull/651))

## [0.23.0] - 2022-05-12

### Bug Fixes

- [`workflow`] Use "correct" default retry policy for local activities ([#630](https://github.com/temporalio/sdk-typescript/pull/630))
- [`activity`] Fix Activity resolved as cancelled in unsupported situations ([#640](https://github.com/temporalio/sdk-typescript/pull/640))
- [`workflow`] Propagate scope cancellation while waiting on ExternalWorkflowHandle cancellation ([#633](https://github.com/temporalio/sdk-typescript/pull/633))
- :boom: Improve Payload Converter logic ([#558](https://github.com/temporalio/sdk-typescript/pull/558))

  BREAKING CHANGE:

  - `PayloadConverter.toPayload(value)` now returns `undefined` when `value` is not of a supported type.
  - The SDK now throws when it receives `undefined` from `toPayload`

### Features

- :boom: Allow for multiple `DataConverter.payloadCodecs` ([#643](https://github.com/temporalio/sdk-typescript/pull/643))

  BREAKING CHANGE: `DataConverter.payloadCodec` was changed to plural:

  ```ts
  export interface DataConverter {
    ...
    payloadCodecs?: PayloadCodec[];
  }
  ```

- [`worker`] Support HTTP headers in `NativeConnection` ([#644](https://github.com/temporalio/sdk-typescript/pull/644))
- :boom: [`worker`] Restructure `TelemetryOptions` ([#646](https://github.com/temporalio/sdk-typescript/pull/646))
  - Also support passing HTTP headers to an OpenTelemetry Collector
  - See the updated interface [here](https://github.com/temporalio/sdk-typescript/blob/6c9730bb5c1299885481fe3cf345001900398fd9/packages/core-bridge/index.d.ts#L123)

### Documentation

- [`workflow`] Fix Trigger example ([#631](https://github.com/temporalio/sdk-typescript/pull/631))

### Miscellaneous Tasks

- [`worker`] Update swc-loader options ([#598](https://github.com/temporalio/sdk-typescript/pull/598))
- [`bundler`] Export allowed and disallowed builtin modules ([#591](https://github.com/temporalio/sdk-typescript/pull/591))
- [`testing`] Use GITHUB_TOKEN in install script for higher rate limit ([#638](https://github.com/temporalio/sdk-typescript/pull/638))

### Testing

- Add query-perf script ([#632](https://github.com/temporalio/sdk-typescript/pull/632))
- Collect worker logs in stress tests ([#634](https://github.com/temporalio/sdk-typescript/pull/634))
- Actually fail stress test when child fails ([#636](https://github.com/temporalio/sdk-typescript/pull/636))
- Fix activity heartbeat timeout crashing nightly ([#641](https://github.com/temporalio/sdk-typescript/pull/641))

## [0.22.0] - 2022-05-02

### Bug Fixes

- [`bundler`] Fix bundler edge cases on Windows ([#619](https://github.com/temporalio/sdk-typescript/pull/619))
- [`workflow`] Fail workflow task instead of run on workflow not found ([#622](https://github.com/temporalio/sdk-typescript/pull/622))

  NOTE: This could be considered backwards incompatible if you were relying on this behavior.
  The new behavior is safer because Temporal will automatically retry these Workflows.

- [`workflow`] Fix case where activity or timer would try to be cancelled without being scheduled ([#621](https://github.com/temporalio/sdk-typescript/pull/621))
- Do not patch global object in otel runtime if not in workflow context ([#626](https://github.com/temporalio/sdk-typescript/pull/626))
- [`core`] Update Core to receive recent fixes ([#627](https://github.com/temporalio/sdk-typescript/pull/627))

### Features

- Support headers to signals and queries with interceptors ([#609](https://github.com/temporalio/sdk-typescript/pull/609))
- :boom: [`worker`]: Move shutdownSignals to RuntimeOptions ([#611](https://github.com/temporalio/sdk-typescript/pull/611))

  BREAKING CHANGE: Move `shutdownSignals` from `WorkerOptions` to [`RuntimeOptions`](https://typescript.temporal.io/api/interfaces/worker.runtimeoptions/):

  ```ts
  // old
  Worker.create({ shutdownSignals: ['SIGINT'], ... })

  // new
  Runtime.install({ shutdownSignals: ['SIGINT'], ... })
  ```

- [`workflow`] Allow signal handlers to be cleared ([#613](https://github.com/temporalio/sdk-typescript/pull/613))

### Documentation

- Add activation sequence diagram ([#605](https://github.com/temporalio/sdk-typescript/pull/605))
- Make snipsync pull from samples-typescript ([#623](https://github.com/temporalio/sdk-typescript/pull/623))

### Refactor

- :boom: [`proto`] Use protobufjs json-modules ([#551](https://github.com/temporalio/sdk-typescript/pull/551))

  BREAKING CHANGE: The `@temporalio/proto` package no longer has files `lib/coresdk` and `lib/temporal`. Any imports from those files must be updated:

  ```ts
  // old
  import type { coresdk } from '@temporalio/proto/lib/coresdk';

  // new
  import type { coresdk } from '@temporalio/proto';
  ```

### Testing

- Add more load test scenarios to CI ([#615](https://github.com/temporalio/sdk-typescript/pull/615))
- Add some additional options to the load test worker script ([#624](https://github.com/temporalio/sdk-typescript/pull/624))

## [0.21.1] - 2022-04-21

### Bug Fixes

- [`core`] Fix worker responding with empty commands during query of uncached workflow ([#602](https://github.com/temporalio/sdk-typescript/pull/602))

### Miscellaneous Tasks

- [`deps`] Update dependency typedoc to ^0.22.0 (main) ([#578](https://github.com/temporalio/sdk-typescript/pull/578))

## [0.21.0] - 2022-04-20

### Bug Fixes

- Update Core with fix where workflows could get stuck if queried and not in cache ([#599](https://github.com/temporalio/sdk-typescript/pull/599))

### Features

- Complete test framework ([#547](https://github.com/temporalio/sdk-typescript/pull/547))

  - Add `NativeConnection.close()` method for explicitly closing a
    connection - before this change NativeConnection would be invalidated
    when all Workers are shutdown because their Runtime would implicitly
    be shutdown.

- :boom: Implement local activities ([#585](https://github.com/temporalio/sdk-typescript/pull/585))

  - BREAKING CHANGE: `ActivityOptions` no longer accepts `namespace`
  - NOTE: This feature is considered experimental and requires some time in production before considered stable

### Testing

- Verify that workflow is not retried if it throws non retryable failure ([#596](https://github.com/temporalio/sdk-typescript/pull/596))

## [0.20.2] - 2022-04-14

### Bug Fixes

- [`core`] Don't eat up a workflow task permit if when evicting a missing run ([#598](https://github.com/temporalio/sdk-typescript/pull/598))
- Compile linux binary linked to older glibc ([#590](https://github.com/temporalio/sdk-typescript/pull/590))

### Features

- [`worker`] Use swc-loader instead of ts-loader ([#588](https://github.com/temporalio/sdk-typescript/pull/588))

  Original work started in ([#525](https://github.com/temporalio/sdk-typescript/pull/525)) and was reverted.

### Miscellaneous Tasks

- [`deps`] Update dependency @svgr/webpack to v6 (main) ([#575](https://github.com/temporalio/sdk-typescript/pull/575))

## [0.20.1] - 2022-04-12

### Bug Fixes

- [`worker`] Update Core submodule to receive fix for potential deadlock ([#583](https://github.com/temporalio/sdk-typescript/pull/583))

  This is a critical fix. Without it, Workers might get "stuck" with no apparent symptoms.

### Features

- [`worker`] Cancel activities on shutdown ([#579](https://github.com/temporalio/sdk-typescript/pull/579))

  Before this change, Activities were oblivious to Worker shutdown. With this change, Activities are notified
  via cancellation when their Worker is shutdown. It is up to the Activity implementor to handle cancellation.

- [`worker`] Add Worker.getStatus() method ([#581](https://github.com/temporalio/sdk-typescript/pull/581))

  Helper for exposing the overall status of a Worker. Useful for troubleshooting problems and observability.

### Documentation

- Update workflow interceptors API reference ([#563](https://github.com/temporalio/sdk-typescript/pull/563))

## [0.20.0] - 2022-04-06

### Features

- :boom: [`worker`] Refactor Core bridge for top level Worker API (#568)

  - Implements the Worker part of [proposal #56](https://github.com/temporalio/proposals/blob/050825aba0e2e6cde91bae81945dce082bd47622/typescript/connections.md)
  - Break down `Core` into `Runtime` and `NativeConnection`
  - Workers now require a `NativeConnection` instance instead of using the singleton `Core` connection
  - By default Core logs are not forwarded into node anymore
  - Various [bug fixes and features](https://github.com/temporalio/sdk-core/compare/85454935e39f789aaaa81f8a05773f8e2cdbcde2...dcae3d6fd66fb22f727ffa14da100f0c08b6a2c8) from updating `sdk-core`

  Before:

  ```ts
  import { Core, Worker } from '@temporalio/worker';

  await Core.install({
    telemetryOptions: ...
    logger: ...
    serverOptions: {
      address: ...
      namespace: ...
    }
  });

  // Worker uses connection of singleton Core
  await Worker.create({
    taskQueue: ...,
    ...
  });
  ```

  After:

  ```ts
  import { Runtime, NativeConnection, Worker } from '@temporalio/worker';

  Runtime.install({
    telemetryOptions: ...
    logger: ...
  });

  const connection = await NativeConnection.create({
    address: ...
  });

  await Worker.create({
    connection,
    namespace: ...
    taskQueue: ...,
    ...
  });
  ```

### Documentation

- [`worker`] Add missing WorkerOptions defaults (#567)

## [0.19.2] - 2022-03-29

### Bug Fixes

- [`worker`] Fix crash when Activity is cancelled with reason `NOT_FOUND` ([#565](https://github.com/temporalio/sdk-typescript/pull/565))
- Export more things from client and worker packages ([#559](https://github.com/temporalio/sdk-typescript/pull/559))
- Use `JsonPayloadConverter` for search attributes ([#546](https://github.com/temporalio/sdk-typescript/pull/546))
  - Temporal doesn't support Null or Binary Payloads for search attributes.
- [`worker`] Fix Windows bundle-writing bug ([#554](https://github.com/temporalio/sdk-typescript/pull/554))
  - Sometimes on Windows in CI, we were getting empty Workflow bundles.

### Features

- [`workflow-bundler`] Allow ignoring modules for Webpack build ([#540](https://github.com/temporalio/sdk-typescript/pull/540), thanks to [`@mjameswh`](https://github.com/mjameswh) 🙏)
- Add testing framework ([#543](https://github.com/temporalio/sdk-typescript/pull/543))
  - Initial work, missing features:
    - No ability to fast forward time outside of a workflow
    - No ability to toggle normal / time skipped mode

### Documentation

- [`client`] Add to `getHandle` documentation ([#550](https://github.com/temporalio/sdk-typescript/pull/550))
- Improve Workflow API reference index ([#560](https://github.com/temporalio/sdk-typescript/pull/560))
  - Use example with both signals and queries for Workflow "Signals and Queries" section

## [0.19.1] - 2022-03-12

### Bug Fixes

- Revert "use swc-loader instead of ts-loader (#525)" ([#535](https://github.com/temporalio/sdk-typescript/pull/535))
  - `swc-loader` was causing a webpack build error when using `ts-node` (see [#534](https://github.com/temporalio/sdk-typescript/issues/534))

## [0.19.0] - 2022-03-12

- :boom: This release includes the breaking changes listed in:
  - [`0.19.0-rc.0`](https://github.com/temporalio/sdk-typescript/blob/main/CHANGELOG.md#0190-rc0---2022-02-25)
  - [`0.19.0-rc.1`](https://github.com/temporalio/sdk-typescript/blob/main/CHANGELOG.md#0190-rc1---2022-03-02)

### Bug Fixes

- :boom: [`worker`] Mark activity errors retryable ([#522](https://github.com/temporalio/sdk-typescript/pull/522))

  BREAKING CHANGE: Before this fix, the `ApplicationFailures` returned by the Worker in these
  two circumstances were not retryable:

  - Activity not found
  - Failed to parse Activity args

- [`worker`] Enhance and fix heartbeat behavior ([#523](https://github.com/temporalio/sdk-typescript/pull/523))

  - Flush last heartbeat on Activity failure
  - Ensure ordering of heartbeats when custom payload codec is used
  - Discard heartbeats if activity sends them faster than payload codec
    can process them
  - Make heartbeat details codec errors fail the activity

- Update `TLSConfig` import location ([#518](https://github.com/temporalio/sdk-typescript/pull/518))
- Use default data converter for search attributes ([#511](https://github.com/temporalio/sdk-typescript/pull/511))
- Add `reason` to cancellation tasks in tests ([#526](https://github.com/temporalio/sdk-typescript/pull/526))
- [`client`] Add interceptor for `handle.describe` ([#484](https://github.com/temporalio/sdk-typescript/pull/484), thanks to [`@andreasasprou`](https://github.com/andreasasprou) 🙏)
- [`workflow`] Properly wait for vm microtasks ([#524](https://github.com/temporalio/sdk-typescript/pull/524))
  - Use `microtaskMode=afterEvaluate` to ensure `isolateExecutionTimeoutMs` includes microtask processing too.

### Features

- :boom: [`client`] Return a friendly type from `handle.describe()` ([#532](https://github.com/temporalio/sdk-typescript/pull/532))

  BREAKING CHANGE: Before this fix, [`WorkflowHandle#describe`](https://typescript.temporal.io/api/interfaces/client.WorkflowHandle#describe) returned the gRPC response [`temporal.api.workflowservice.v1.IDescribeWorkflowExecutionResponse`](https://typescript.temporal.io/api/interfaces/proto.temporal.api.workflowservice.v1.IDescribeWorkflowExecutionResponse). It now returns a [`WorkflowExecutionDescription`](https://typescript.temporal.io/api/classes/client.WorkflowExecutionDescription).

  - Closes [#482](https://github.com/temporalio/sdk-typescript/issues/482)

- [`worker`] Use `swc-loader` instead of `ts-loader` ([#525](https://github.com/temporalio/sdk-typescript/pull/525), thank you [@julianocomg](https://github.com/julianocomg) 🙏)
- [`client`] Add methods to set grpc metadata and deadline for service calls ([#513](https://github.com/temporalio/sdk-typescript/pull/513))
- [`client`] Minor connection improvements ([#533](https://github.com/temporalio/sdk-typescript/pull/533))
  - Upgrade grpc-js dependency to ^1.5.7
  - Export `*` from `grpc-retry`
  - Use more exact type for `ConnectionOptions.channelArgs`
  - Set `grpc.default_authority` channel arg if `serverNameOverride` is
    provided (closes [#455](https://github.com/temporalio/sdk-typescript/issues/455))

### Miscellaneous Tasks

- Get static checking of encoding Failures and Completions ([#520](https://github.com/temporalio/sdk-typescript/pull/520))
- Make forks work with sdk-features ([#502](https://github.com/temporalio/sdk-typescript/pull/502))
- Update otel packages ([#515](https://github.com/temporalio/sdk-typescript/pull/515))

### Documentation

- Fix order in publishing script ([#510](https://github.com/temporalio/sdk-typescript/pull/510))
- Update docusaurus ([#512](https://github.com/temporalio/sdk-typescript/pull/512))
- Add undefined to supported data types ([#517](https://github.com/temporalio/sdk-typescript/pull/517))
- Surface RequiredTelemetryOptions for API docs ([#527](https://github.com/temporalio/sdk-typescript/pull/527))

## [0.19.0-rc.1] - 2022-03-02

### Features

- :boom: Custom and protobuf data converters ([#477](https://github.com/temporalio/sdk-typescript/pull/477))

  BREAKING CHANGE: [`DataConverter`](https://typescript.temporal.io/api/interfaces/worker.DataConverter) interface has changed, and some things that were exported from `common` no longer are. If it's no longer exported (see [list of exports](https://typescript.temporal.io/api/namespaces/common)), try importing from `@temporalio/activity|client|worker|workflow`. If you're unable to find it, open an issue for us to fix it, and in the meantime import from [`internal-workflow-common`](https://github.com/temporalio/sdk-typescript/tree/main/packages/internal-workflow-common) or [`internal-non-workflow-common`](https://github.com/temporalio/sdk-typescript/tree/main/packages/internal-non-workflow-common).

  - Adds custom data converter feature and changes the DataConverter API. Design doc: https://github.com/temporalio/sdk-typescript/tree/main/docs/data-converter.md#decision

    ```ts
    interface DataConverter {
      payloadConverterPath?: string;
      payloadCodec?: PayloadCodec;
    }

    interface PayloadConverter {
      toPayload<T>(value: T): Payload | undefined;
      fromPayload<T>(payload: Payload): T;
    }

    interface PayloadCodec {
      encode(payloads: Payload[]): Promise<Payload[]>;
      decode(payloads: Payload[]): Promise<Payload[]>;
    }
    ```

    Note: Codec is not yet run on Payloads in interceptor headers.

  - Separated `common` package into:
    ```
    common
    internal-workflow-common
    internal-non-workflow-common
    ```
    The new `common` only exports things you might want to use in your own common code (shared between client/worker/workflow) like data converters, failures, and errors. The default exports of `common` and `internal-workflow-common` are included in the Workflow bundle.
  - Unreverts [#430](https://github.com/temporalio/sdk-typescript/pull/430) and modified the Protobuf data converter API: https://github.com/temporalio/sdk-typescript/tree/main/docs/protobuf-libraries.md#current-solution
  - Make `assert` available to Workflows.
  - Closes [#130](https://github.com/temporalio/sdk-typescript/issues/130)
  - Closes [#237](https://github.com/temporalio/sdk-typescript/issues/237)
  - Closes [#434](https://github.com/temporalio/sdk-typescript/issues/434)

### Bug Fixes

- Re-export possibly-shared-use things in common (#509)

### Miscellaneous Tasks

- Fix linting on test-otel ([#504](https://github.com/temporalio/sdk-typescript/pull/504))

### Documentation

- Add info to publishing notes ([#503](https://github.com/temporalio/sdk-typescript/pull/503))
- Link to source proto; improve Publishing ([#507](https://github.com/temporalio/sdk-typescript/pull/507))

## [0.19.0-rc.0] - 2022-02-25

### Bug Fixes

- :boom: [`workflow-bundler`] Enable resolution of modules in Webpack based on Node's regular algorithm ([#498](https://github.com/temporalio/sdk-typescript/pull/498), thank you [@mjameswh](https://github.com/mjameswh) 🙏)

  BREAKING CHANGE: [`Worker.create`](https://typescript.temporal.io/api/classes/worker.Worker#create) no longer takes `nodeModulesPaths`. Instead, it resolves modules like Node does, relative to [`workflowsPath`](https://typescript.temporal.io/api/interfaces/worker.WorkerOptions#workflowspath).

  This fixes [#489](https://github.com/temporalio/sdk-typescript/issues/489) and may fix issues with monorepos.

- [`workflow`] Fix ContinueAsNew error message and name ([#487](https://github.com/temporalio/sdk-typescript/pull/487))

  - Treat ContinueAsNew as success in otel interceptor span status

- [`workflow-bundler`] Improve resolving of webpack's `ts-loader` ([#492](https://github.com/temporalio/sdk-typescript/pull/492), thank you [@jameslnewell](https://github.com/jameslnewell) 🙏)
  - Addresses issues where it's not found in complex workspaces like a yarn workspaces monorepo
- Remove `console.log` emitted from core bridge ([#500](https://github.com/temporalio/sdk-typescript/pull/500))

### Documentation

- Link to `building.md` from `# Publishing` section ([#479](https://github.com/temporalio/sdk-typescript/pull/479))
- Specify default Workflow Execution retry behavior ([#495](https://github.com/temporalio/sdk-typescript/pull/495))
- Add breaking change notice to `CHANGELOG` for `v0.18.0` ([#494](https://github.com/temporalio/sdk-typescript/pull/494))
  - Closes [#493](https://github.com/temporalio/sdk-typescript/pull/493)
- Remove inaccurate `startChild` typedoc notes ([#448](https://github.com/temporalio/sdk-typescript/pull/448))

### Testing

- Add integration with sdk-features repo ([#453](https://github.com/temporalio/sdk-typescript/pull/453))
- Pass repo into sdk-features workflow ([#486](https://github.com/temporalio/sdk-typescript/pull/486))

## [0.18.0] - 2022-02-10

### Bug Fixes

- :boom: Improve failure details ([#467](https://github.com/temporalio/sdk-typescript/pull/467))

  BREAKING CHANGE: Most `failure.message` fields are no longer prefixed with `'Error: '`, so places in which you're checking `failure.message === 'Error: a message'` likely need to be changed to `failure.message === 'a message'`.

- [`workflow`] Fix startChild options type ([#447](https://github.com/temporalio/sdk-typescript/pull/447))
- [`workflow`] Fix error when timer is cancelled and immediately fired in the same activation ([#466](https://github.com/temporalio/sdk-typescript/pull/466))

- Upgrade Core to receive recent fixes ([#475](https://github.com/temporalio/sdk-typescript/pull/475))

  - Replay mock client wasn't allowing completes ([sdk-core#269](https://github.com/temporalio/sdk-core/pull/269))
  - Fix heartbeats not flushing on activity completion ([sdk-core#266](https://github.com/temporalio/sdk-core/pull/266))

- Don't register errors more than once, allowing for multiple module imports w/o panic ([#474](https://github.com/temporalio/sdk-typescript/pull/474))

### Features

- :boom: [`client`] Use `runId` only in handles created with `getHandle` ([#468](https://github.com/temporalio/sdk-typescript/pull/468))

  - In addition:
    - Adds safety to `terminate` and `cancel` so handles created with `start` can't accidentally affect workflows that are not part of the same execution chain
    - Adds optional `firstExecutionRunId` param to `getHandle` for added safety
  - Closes [#464](https://github.com/temporalio/sdk-typescript/pull/464)
  - Closes [#377](https://github.com/temporalio/sdk-typescript/pull/377)
  - Closes [#365](https://github.com/temporalio/sdk-typescript/pull/365)

  BREAKING CHANGE: Some gRPC errors are no longer being thrown from `WorkflowClient`. These errors are thrown in their place: [`WorkflowExecutionAlreadyStartedError`](https://typescript.temporal.io/api/classes/common.workflowexecutionalreadystartederror/) and [`WorkflowNotFoundError`](https://typescript.temporal.io/api/classes/common.workflownotfounderror/). This means that, for example, code like this:

  ```ts
  try {
    await client.start(example, { workflowId: '123' });
  } catch (e: any) {
    if (e.code === ALREADY_EXISTS) {
      console.log('Already started workflow 123');
    }
  }
  ```

  Needs to be changed to:

  ```ts
  import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';

  try {
    await client.start(example, { workflowId: '123' });
  } catch (e: any) {
    if (e instanceof WorkflowExecutionAlreadyStartedError) {
      console.log('Already started workflow 123');
    }
  }
  ```

- Replay history from files ([#449](https://github.com/temporalio/sdk-typescript/pull/449))
  - Provides a way to exercise existing histories against local workflow code. See [video tutorial](https://www.youtube.com/watch?v=fN5bIL7wc5M) and [sample code](https://github.com/temporalio/samples-typescript/pull/99).
- [`core`] Make Core portable ([#458](https://github.com/temporalio/sdk-typescript/pull/458))
  - Installing the SDK on one OS / architecture now works if used on different OS / arch.
- Accept IHistory for history replay ([#460](https://github.com/temporalio/sdk-typescript/pull/460))

### Miscellaneous Tasks

- Handle proto renaming / repackaging updates from core ([#446](https://github.com/temporalio/sdk-typescript/pull/446))
- Add MakeOptional and Replace type helpers ([#401](https://github.com/temporalio/sdk-typescript/pull/401))
- Fix core-bridge main entry in package.json ([#463](https://github.com/temporalio/sdk-typescript/pull/463))

## [0.17.2] - 2021-12-28

### Bug Fixes

- Reverted ([#430](https://github.com/temporalio/sdk-typescript/pull/430)) which added protobuf payload converters

  This broke Workflows for some users who had the `assert` package installed in their `node_modules` folder.
  `proto3-json-serializer` (added in this PR) requires `assert` which transitively requires `utils` which relies on `process` being available.

## [0.17.1] - 2021-12-27

### Bug Fixes

- Fix Workflow retryable `ApplicationFailure` fails execution ([#432](https://github.com/temporalio/sdk-typescript/pull/432))

  - Makes `ApplicationFailure.retryable` fail the workflow execution and not the task as intended, this was wrongly implemented in [#429](https://github.com/temporalio/sdk-typescript/pull/429).

- Update core submodule to receive recent bugfixes ([#433](https://github.com/temporalio/sdk-typescript/pull/433))
  - Fix WFT failures sometimes getting stuck in a spam loop ([sdk-core#240](https://github.com/temporalio/sdk-core/pull/240))
  - Move warning message for failed activations to be only during reports ([sdk-core#242](https://github.com/temporalio/sdk-core/pull/242))
  - Fix double-application of an empty WFT when handling legacy queries ([sdk-core#244](https://github.com/temporalio/sdk-core/pull/244))

### Features

- Add Protobuf binary and JSON data converter and WorkerOptions.dataConverterPath ([#430](https://github.com/temporalio/sdk-typescript/pull/430))

  - Renamed `WorkerOptions.dataConverter` to `WorkerOptions.dataConverterPath`: path to a module with `dataConverter` named export. This is needed in order to get the run the data converter in the node worker thread.
  - Added `ProtobufBinaryDataConverter` `ProtobufJsonDataConverter` that convert protobufjs JSON modules based arguments and return types to and from Payloads.

  **IMPORTANT**:

  Workflow cannot deserialize protobuf messages yet as it still uses the default data converter - the ability to customize the workflow data converter is coming soon.

  Design notes:

  https://github.com/temporalio/sdk-typescript/blob/main/docs/protobuf-libraries.md

  Other notes:

  - Other SDKs, can read protobuf payloads generated by the TypeScript SDK
  - Other SDKs, when protobuf-serializing, must include the name of the class in `payload.metadata.messageType` for the TS SDK to read
    - **This has not been implmented yet**
    - Will later be used by the UI

## [0.17.0] - 2021-12-17

### Bug Fixes

- Use bundled Workflow interceptors ([#427](https://github.com/temporalio/sdk-typescript/pull/427))

  Addresses issue [#390](https://github.com/temporalio/sdk-typescript/issues/390) where workflow interceptor modules might not be present when using pre-bundled workflow code.

### Features

- :boom: Add validation to retry policy and use a TS friendly interface everywhere ([#426](https://github.com/temporalio/sdk-typescript/pull/426))

  - `RetryOptions` was renamed `RetryPolicy`
  - client `WorkflowOptions` no longer accepts protobuf `retryPolicy` instead it has a TS `RetryPolicy` `retry` attribute

- Implement async Activity completion ([#428](https://github.com/temporalio/sdk-typescript/pull/428))

  - Activity can throw [`CompleteAsyncError`](https://typescript.temporal.io/api/classes/activity.completeasyncerror/) to ask the worker to forget about it
  - Later on the [`AsyncCompletionClient`](https://typescript.temporal.io/api/classes/client.asynccompletionclient/) can be used to complete that activity

- [`workflow`] Handle unhandled rejections in workflow code ([#415](https://github.com/temporalio/sdk-typescript/pull/415))

  - Associate unhandled rejections from workflow code to a specific runId.
  - Makes the unhandled rejection behavior consistent between node 14 and 16 and propagates failure back to the user.
    Previously, in node 16 the process would crash and in node 14 we would incorrectly ignore rejections leading to unexpected workflow behavior.

- :boom: [`workflow`] Make random workflow errors retryable ([#429](https://github.com/temporalio/sdk-typescript/pull/429))

  BREAKING CHANGE: Before this change throwing an error in a Workflow
  would cause the Workflow execution to fail. After the change only the
  Workflow task fails on random errors.
  To fail the Workflow exection throw `ApplicationFailure.nonRetryable`.

  To make other error types non retryable use the
  `WorkflowInboundCallsInterceptor` `execute` and `handleSignal` methods
  to catch errors thrown from the Workflow and convert them to non
  retryable failures, e.g:

  ```ts
  class WorkflowErrorInterceptor implements WorkflowInboundCallsInterceptor {
    async execute(
      input: WorkflowExecuteInput,
      next: Next<WorkflowInboundCallsInterceptor, 'execute'>
    ): Promise<unknown> {
      try {
        return await next(input);
      } catch (err) {
        if (err instanceof MySpecialNonRetryableError) {
          throw ApplicationFailure.nonRetryable(err.message, 'MySpecialNonRetryableError');
        }
        throw err;
      }
    }
  }
  ```

  NOTE: Propagated Activity and child Workflow failures are considered non
  retryable and will fail the workflow execution.

## [0.16.4] - 2021-12-08

### Bug Fixes

- Update core to fix workflow semaphore not released on cache miss ([#424](https://github.com/temporalio/sdk-typescript/pull/424))

### Features

- Default `WorkflowHandle` generic T param to `Workflow` ([#419](https://github.com/temporalio/sdk-typescript/pull/419))

### Miscellaneous Tasks

- Add comments for unused query and signal generics ([#402](https://github.com/temporalio/sdk-typescript/pull/402))
- [`docs`] Expose worker.CoreOptions ([#416](https://github.com/temporalio/sdk-typescript/pull/416))
- [`docs`] Expose BundleOptions and remove `__namedParameters` ([#404](https://github.com/temporalio/sdk-typescript/pull/404))

- Remove proto usage from workflow runtime ([#423](https://github.com/temporalio/sdk-typescript/pull/423))

  This is now possible because we're using vm instead of isolated-vm.

  - Greatly reduce workflow bundle size - SDK test bundle size went down from 2.77MB to 0.73MB
  - Step 1 in supporting custom data converter

### Testing

- Ignore github actions jobs that require secrets for external committers ([#414](https://github.com/temporalio/sdk-typescript/pull/414))

## [0.16.3] - 2021-11-29

### Bug Fixes

- [`workflow`] Fix argument wrapping in array when signaling from Workflow ([#410](https://github.com/temporalio/sdk-typescript/pull/410))

  Before this fix, signal arguments sent from a workflow would be wrapped in an array, e.g:

  ```ts
  await child.signal(someSignal, 1, '2');
  ```

  Was received in the child workflow as:

  ```ts
  wf.setHandler(someSignal, (num: number, str: string) => {
    console.log(num, str); // [1, '2'] undefined
  });
  ```

- [`core`] Upgrade Core to receive fixes to activity heartbeats ([#411](https://github.com/temporalio/sdk-typescript/pull/411))

  - Fix hang in case Activity completes after heartbeat response indicates Activity timed out.

  - Behavior was incorrect and not inline with the other SDKs.
    Heartbeats are now throttled using a timer and Core does not count on user to keep sending heartbeats in order flush them out.

    Added 2 new `WorkerOption`s to control throttling:

    - `maxHeartbeatThrottleInterval`
    - `defaultHeartbeatThrottleInterval`

### Miscellaneous Tasks

- [`docs`] Explain that getHandle doesn't validate workflowId ([#400](https://github.com/temporalio/sdk-typescript/pull/400))

- Don't use fs-extra in create-project ([#412](https://github.com/temporalio/sdk-typescript/pull/412))

  Fixes issue where fs-extra is incompatible with ESM as reported on slack.

## [0.16.2] - 2021-11-23 - beta

### Features

- [`worker`] Add `WorkerOptions.debugMode` to enable debugging Workflows ([#398](https://github.com/temporalio/sdk-typescript/pull/398))

## [0.16.1] - 2021-11-22 - beta-rc.1

### Features

- [`create-project`] Use chalk-template instead of chalk-cli ([#396](https://github.com/temporalio/sdk-typescript/pull/396))
  - Fixes issues where `npx @temporalio/create` fails to resolve the `chalk` executable

## [0.16.0] - 2021-11-19 - beta-rc.0

### Bug Fixes

- [`core`] Update Core w/ specifying queue kind on polling ([#389](https://github.com/temporalio/sdk-typescript/pull/389))

  - Must be specified for optimization reasons on server

- [`core`] Update Core to receive bugfixes ([#391](https://github.com/temporalio/sdk-typescript/pull/391))

  - Fix a situation where Core could get stuck polling if WFTs were repeatedly being failed
  - Do not fail Workflow if Lang (TypeScript) cancels something that's already completed (e.g. activity, timer, child workflow)
  - Fix for Core accidentally still sending commands sometimes for things that were cancelled immediately

### Features

- :boom: [`client`] Make `workflowId` required ([#387](https://github.com/temporalio/sdk-typescript/pull/387))

  Also remove `WorkflowClientOptions.workflowDefaults`.

  Reasoning:

  - Workflow IDs should represent a meaningful business ID
  - Workflow IDs can be used as an idempotency key when starting workflows from an external signal
  - `workflowDefaults` were removed because their presence made `taskQueue` optional in `WorkflowOptions`, omitting it from both the defaults and options resulted in runtime errors where we could have caught those at compile time.

  Migration:

  ```ts
  // Before
  const client = new WorkflowClient(conn.service, { workflowDefaults: { taskQueue: 'example' } });
  const handle = await client.start(myWorkflow, { args: [foo, bar] });
  // After
  const client = new WorkflowClient(conn.service);
  const handle = await client.start(myWorkflow, {
    args: [foo, bar],
    taskQueue: 'example',
    workflowId: 'a-meaningful-business-id',
  });
  ```

- Support Windows development ([#385](https://github.com/temporalio/sdk-typescript/pull/385))

  - Support was added for using and developing the SDK on Windows
  - Thanks @cons0l3 and @cretz for the contribution

- [`workflow`] Use vm instead of isolated-vm ([#264](https://github.com/temporalio/sdk-typescript/pull/264))

  - Removes the `node-gyp` dependency and speeds up installation times
  - Uses Node's built-in `AsyncLocalStorage` implementation instead of our own
  - :boom: Requires an additional workflow interceptor if using `@temporalio/interceptors-opentelemetry`

  ```ts
  import { WorkflowInterceptors } from '@temporalio/workflow';
  import {
    OpenTelemetryInboundInterceptor,
    OpenTelemetryOutboundInterceptor,
    OpenTelemetryInternalsInterceptor,
  } from '@temporalio/interceptors-opentelemetry/lib/workflow';

  export const interceptors = (): WorkflowInterceptors => ({
    inbound: [new OpenTelemetryInboundInterceptor()],
    outbound: [new OpenTelemetryOutboundInterceptor()],
    // Disposes of the internal AsyncLocalStorage used for
    // the otel workflow context manager.
    internals: [new OpenTelemetryInternalsInterceptor()], // <-- new
  });
  ```

  - Unexpose the `isolatePoolSize` and `isolateExecutionTimeout` `WorkerOptions`

## [0.15.0] - 2021-11-11

### Bug Fixes

- Fix type imports ([#361](https://github.com/temporalio/sdk-typescript/pull/361))

- Update core, changes for no more WF update errors ([#366](https://github.com/temporalio/sdk-typescript/pull/366))

  Failing a Workflow task before this change could put the workflow in a stuck state.

- :boom: [`workflow`] Throw if patches are used at Workflow top level ([#369](https://github.com/temporalio/sdk-typescript/pull/369))
- :boom: [`workflow`] Cancel timer created by condition ([#372](https://github.com/temporalio/sdk-typescript/pull/372))

  Also clean up resources taken by the blocked condition.<br>
  **This change is incompatible with old Workflow histories**.

- :boom: [`workflow`] Ensure signals are always processed ([#380](https://github.com/temporalio/sdk-typescript/pull/380))

  This fixes a critical issue where the SDK was not processing history events in the right order, for example, patches and signals should always be delivered before other events in the context of a single Workflow Task.

  **This change is incompatible with old Workflow histories**.

### Features

- :boom: [`workflow`] Change condition parameter order ([#371](https://github.com/temporalio/sdk-typescript/pull/371))

  ```ts
  // Before
  const conditionIsTrue = await condition('1s', () => someBooleanVariable);
  // After
  const conditionIsTrue = await condition(() => someBooleanVariable, '1s');
  ```

- :boom: Rename ExternalDependencies to Sinks ([#370](https://github.com/temporalio/sdk-typescript/pull/370))
- Support complication on Mac for aarch64-unknown-linux-gnu ([#378](https://github.com/temporalio/sdk-typescript/pull/378))

## [0.14.0] - 2021-11-03

### Bug Fixes

- Add missing index.d.ts to published files in core-bridge package ([#347](https://github.com/temporalio/sdk-typescript/pull/347))
- [`docs`] Update algolia index name ([#350](https://github.com/temporalio/sdk-typescript/pull/350))
- [`core`] Update core to gain infinite poll retries ([#355](https://github.com/temporalio/sdk-typescript/pull/355))
- [`worker`] Fix Worker possible hang after graceful shutdown period expires ([#356](https://github.com/temporalio/sdk-typescript/pull/356))

### Features

- :boom: [`workflow`] Rename `createActivityHandle` to `proxyActivities` ([#351](https://github.com/temporalio/sdk-typescript/pull/351))
- The function's usage remains the same, only the name was changed.

  Before:

  ```ts
  import { createActivityHandle } from '@temporalio/workflow';
  import type * as activities from './activities';

  const { greet } = createActivityHandle<typeof activities>({
    startToCloseTimeout: '1 minute',
  });
  ```

  After:

  ```ts
  import { proxyActivities } from '@temporalio/workflow';
  import type * as activities from './activities';

  const { greet } = proxyActivities<typeof activities>({
    startToCloseTimeout: '1 minute',
  });
  ```

  Reasoning:

  - Clarify that the method returns a proxy
  - Avoid confusion with `WorkflowHandle`

- :boom: [`workflow`] Rename `setListener` to `setHandler` ([#352](https://github.com/temporalio/sdk-typescript/pull/352))

  BREAKING CHANGE: The function's usage remains the same, only the name was changed.

  Before:

  ```ts
  import { defineSignal, setListener, condition } from '@temporalio/workflow';
  import { unblockSignal } from './definitions';

  export const unblockSignal = defineSignal('unblock');

  export async function myWorkflow() {
    let isBlocked = true;
    setListener(unblockSignal, () => void (isBlocked = false));
    await condition(() => !isBlocked);
  }
  ```

  After:

  ```ts
  import { defineSignal, setHandler, condition } from '@temporalio/workflow';
  import { unblockSignal } from './definitions';

  export const unblockSignal = defineSignal('unblock');

  export async function myWorkflow() {
    let isBlocked = true;
    setHandler(unblockSignal, () => void (isBlocked = false));
    await condition(() => !isBlocked);
  }
  ```

  Reasoning:

  - It was our go-to name initially but we decided against it when to avoid confusion with the `WorkflowHandle` concept
  - Handling seems more accurate about what the function is doing than listening
  - With listeners it sounds like you can set multiple listeners, and handler doesn't

- [`worker`] Add SIGUSR2 to default list of shutdown signals ([#346](https://github.com/temporalio/sdk-typescript/pull/346))
- :boom: [`client`] Use failure classes for WorkflowClient errors

  - Error handling for `WorkflowClient` and `WorkflowHandle` `execute` and `result` methods now throw
    `WorkflowFailedError` with the specific `TemporalFailure` as the cause.
    The following error classes were renamed:

    - `WorkflowExecutionFailedError` was renamed `WorkflowFailedError`.
    - `WorkflowExecutionContinuedAsNewError` was renamed
      `WorkflowContinuedAsNewError`.

  Before:

  ```ts
  try {
    await WorkflowClient.execute(myWorkflow, { taskQueue: 'example' });
  } catch (err) {
    if (err instanceof WorkflowExecutionFailedError && err.cause instanceof ApplicationFailure) {
      console.log('Workflow failed');
    } else if (err instanceof WorkflowExecutionTimedOutError) {
      console.log('Workflow timed out');
    } else if (err instanceof WorkflowExecutionTerminatedError) {
      console.log('Workflow terminated');
    } else if (err instanceof WorkflowExecutionCancelledError) {
      console.log('Workflow cancelled');
    }
  }
  ```

  After:

  ```ts
  try {
    await WorkflowClient.execute(myWorkflow, { taskQueue: 'example' });
  } catch (err) {
    if (err instanceof WorkflowFailedError) {
    ) {
      if (err.cause instanceof ApplicationFailure) {
        console.log('Workflow failed');
      } else if (err.cause instanceof TimeoutFailure) {
        console.log('Workflow timed out');
      } else if (err.cause instanceof TerminatedFailure) {
        console.log('Workflow terminated');
      } else if (err.cause instanceof CancelledFailure) {
        console.log('Workflow cancelled');
      }
  }
  ```

## [0.13.0] - 2021-10-29

### Bug Fixes

- Fix and improve opentelemetry interceptors ([#340](https://github.com/temporalio/sdk-typescript/pull/340))
  - :boom: Make `makeWorkflowExporter` resource param required
  - Fix Workflow span timestamps
  - Disable internal SDK tracing by default
  - Connect child workflow traces to their parent
  - Connect continueAsNew traces
  - Add activity type and workflow type to span names and copy format from Java SDK
  - :boom: Some breaking changes were made to the interceptor interfaces
    - `workflowType` input attribute is now consistently called `workflowType`
  - Change trace header name for compatibility with Go and Java tracing implementations

### Features

- Support bundling Workflow code prior to Worker creation ([#336](https://github.com/temporalio/sdk-typescript/pull/336))
- :boom: Refactor WorkflowHandle creation ([#343](https://github.com/temporalio/sdk-typescript/pull/343))

  - `WorkflowClient.start` now returns a `WorkflowHandle`
  - `WorkflowHandle` no longer has `start`, `signalWithStart` and
    `execute` methods
  - `WorkflowClient.signalWithStart` was added
  - To get a handle to an existing Workflow use `WorkflowClient.getHandle`
  - `wf.createChildWorklowHandle` was renamed to `wf.startChild` and
    immediately starts the Workflow
  - `wf.executeChild` replaces `ChildWorkflowHandle.execute`
  - `wf.createExternalWorkflowHandle` was renamed to
    `wf.getExternalWorkflowHandle`

  #### Migration Guide

  **WorkflowClient - Starting a new Workflow**

  Before:

  ```ts
  const handle = await client.createWorkflowHandle(myWorkflow, { taskQueue: 'q' });
  await handle.start(arg1, arg2);
  ```

  After:

  ```ts
  const handle = await client.start(myWorkflow, { taskQueue: 'q', args: [arg1, arg2] });
  ```

  **WorkflowClient - Starting a new Workflow and awaiting completion**

  Before:

  ```ts
  const handle = await client.createWorkflowHandle(myWorkflow, { taskQueue: 'q' });
  const result = await handle.execute(arg1, arg2);
  ```

  After:

  ```ts
  const result = await client.execute(myWorkflow, { taskQueue: 'q', args: [arg1, arg2] });
  ```

  **WorkflowClient - signalWithStart**

  Before:

  ```ts
  const handle = await client.createWorkflowHandle(myWorkflow, { taskQueue: 'q' });
  await handle.signalWithStart(signalDef, [signalArg1, signalArg2], [wfArg1, wfArg2]);
  ```

  After:

  ```ts
  await client.signalWithStart(myWorkflow, {
    args: [wfArg1, wfArg2],
    taskQueue: 'q',
    signal: signalDef,
    signalArgs: [signalArg1, signalArg2],
  });
  ```

  **WorkflowClient - Get handle to an existing Workflow**

  Before:

  ```ts
  const handle = await client.createWorkflowHandle({ workflowId });
  ```

  After:

  ```ts
  const handle = await client.getHandle(workflowId);
  ```

  **`@temporalio/workflow` - Start Child Workflow**

  Before:

  ```ts
  const handle = await workflow.createChildWorkflowHandle(myWorkflow, { taskQueue: 'q' });
  await handle.start(arg1, arg2);
  ```

  After:

  ```ts
  const handle = await workflow.startChild(myWorkflow, { taskQueue: 'q', args: [arg1, arg2] });
  ```

  **`@temporalio/workflow` - Start Child Workflow and await completion**

  Before:

  ```ts
  const handle = await workflow.createChildWorkflowHandle(myWorkflow, { taskQueue: 'q' });
  const result = await handle.execute(arg1, arg2);
  ```

  After:

  ```ts
  const result = await workflow.executeChild(myWorkflow, { taskQueue: 'q', args: [arg1, arg2] });
  ```

  **`@temporalio/workflow` - Get handle to an external Workflow**

  Before:

  ```ts
  const handle = await workflow.createExternalWorkflowHandle(workflowId);
  ```

  After:

  ```ts
  const handle = await workflow.getExternalWorkflowHandle(workflowId);
  ```

### Miscellaneous Tasks

- Strip snipsync and exclude .dirs ([#332](https://github.com/temporalio/sdk-typescript/pull/332))
- Cleanup some TODOs and unaddressed PR comments ([#342](https://github.com/temporalio/sdk-typescript/pull/342))

### Testing

- Update docker-compose server version to 1.13.0 ([#338](https://github.com/temporalio/sdk-typescript/pull/338))

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
