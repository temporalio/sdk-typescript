# Changelog

All notable changes to this project will be documented in this file.

Breaking changes marked with a :boom:

## [1.4.0] - 2022-09-28

### Features

- :boom: Make client gRPC retry more configurable ([#879](https://github.com/temporalio/sdk-typescript/pull/879))

  BREAKING CHANGE: [`GrpcRetryOptions.retryableDecider`](https://typescript.temporal.io/api/interfaces/client.grpcretryoptions/#retryabledecider) now gets the `attempt` number as the first argument. This is an advanced/rare option, and the change should be caught at compile time.

  Also adds [`BackoffOptions`](https://typescript.temporal.io/api/interfaces/client.backoffoptions/) and [`defaultGrpcRetryOptions`](https://typescript.temporal.io/api/namespaces/client/#defaultgrpcretryoptions).

  NOTE: This feature is experimental and its API may change.

- [`client`] Delete search attributes with empty array values in describe() response ([#878](https://github.com/temporalio/sdk-typescript/pull/878))

  :warning: This fixes a bug where empty/deleted Custom Search Attributes were returned as `[]` from [`workflowHandle.describe()`](https://typescript.temporal.io/api/interfaces/client.workflowhandle/#describe). Such attribute properties will no longer be present in the [`WorkflowExecutionDescription.searchAttributes`](https://typescript.temporal.io/api/interfaces/client.WorkflowExecutionDescription#searchattributes) object. Note that this behavior is consistent with what you'll see if using a pre-1.4 version of the SDK with Server version 1.18.

- Add support for custom failure converters ([#887](https://github.com/temporalio/sdk-typescript/pull/887))

  Adds [`DataConverter.failureConverterPath`](https://typescript.temporal.io/api/interfaces/worker.dataconverter/#failureconverterpath) and [`FailureConverter`](https://typescript.temporal.io/api/interfaces/common.FailureConverter), which converts from proto Failure instances to JS Errors and back.

  We recommended going with the default (i.e. not using the `failureConverterPath` option) in order to maintain cross-language Failure serialization compatibility.

  NOTE: This feature is experimental and its API may change.

- [`workflow`] Add [`workflowInfo().unsafe.now()`](https://typescript.temporal.io/api/interfaces/workflow.UnsafeWorkflowInfo/#now) ([#882](https://github.com/temporalio/sdk-typescript/pull/882))

  It returns the current system time in milliseconds. The safe version of time is `new Date()` and `Date.now()`, which are set on the first invocation of a Workflow Task and stay constant for the duration of the Task and during replay.

- Upgrade core, add support for OTEL metric temporality ([#891](https://github.com/temporalio/sdk-typescript/pull/891))

  - Upgraded otel and other deps ([temporalio/sdk-core#402](https://github.com/temporalio/sdk-core/pull/402))
  - Fix incorrect string names for polling methods ([temporalio/sdk-core#401](https://github.com/temporalio/sdk-core/pull/401))

### Miscellaneous Tasks

- Remove `internal-*` packages ([#881](https://github.com/temporalio/sdk-typescript/pull/881))

  :warning: Any imports from `@temporalio/internal-*` need to be updated. As noted in their named and READMEs, they're not meant to be used to directly, so we don't imagine this is a common case. However, if you do find instances, they should be changed to importing from:

  ```
  @temporalio/internal-non-workflow-common ➡️ @temporalio/common/lib/internal-non-workflow
  @temporalio/internal-workflow-common ➡️ @temporalio/common
  ```

- [`common`] Deprecate internal functions that should have never been exported ([#893](https://github.com/temporalio/sdk-typescript/pull/889))

  Some time-related and binary conversion internal helper functions were exported from `@temporalio/common`. They are now deprecated and hidden from the API reference, as they're meant for internal use only.

- [`workflow`] Export `LoggerSinks` from `@temporalio/workflow` ([#889](https://github.com/temporalio/sdk-typescript/pull/889))
- [`client`] Add [max retry interval](https://typescript.temporal.io/api/interfaces/client.backoffoptions/#maxintervalms) for client ([#883](https://github.com/temporalio/sdk-typescript/pull/883))
- Label grpc-retry API as experimental ([#891](https://github.com/temporalio/sdk-typescript/pull/891))
- Make the failure-converter code symmetric ([#891](https://github.com/temporalio/sdk-typescript/pull/891))

### Bug Fixes

- Fix double import of long in generated proto TS files ([#891](https://github.com/temporalio/sdk-typescript/pull/891))
- Fix bundler with default workflow interceptors ([#891](https://github.com/temporalio/sdk-typescript/pull/891))
- Limit eager activity requests to 3 ([#891](https://github.com/temporalio/sdk-typescript/pull/891))

## [1.3.0] - 2022-09-20

### Bug Fixes

- :boom: Various bug fixes ([#873](https://github.com/temporalio/sdk-typescript/pull/873))

  BREAKING CHANGE: Makes `WorkflowExecutionDescription.historyLength` a number. This was a `Long` before, but shouldn't
  have been. If you're currently calling:

  ```ts
  (await workflowHandle.describe()).historyLength.toNumber();
  ```

  then remove the `.toNumber()` call.

  This PR also included:

  - Make `protobufjs` a dev dependency of `@temporalio/client`
  - Use simple version of Core's `cancelChildWorkflowExecution` command

- :boom: Update Core from [`e261`](https://github.com/temporalio/sdk-core/tree/e261de3c38b47b29be0db209e9a4758250593034) to [`b437`](https://github.com/temporalio/sdk-core/tree/b437737) ([#865](https://github.com/temporalio/sdk-typescript/pull/865) and [#873](https://github.com/temporalio/sdk-typescript/pull/873))

  BREAKING CHANGE: This fixes a bug where values (memo, search attributes, and retry policy) were not being passed on to
  the next Run during Continue-As-New. Now they are, unless you specify different values when calling
  [`continueAsNew`](https://typescript.temporal.io/api/namespaces/workflow/#continueasnew)
  ([temporalio/sdk-core#376](https://github.com/temporalio/sdk-core/pull/376)). _[We believe this is unlikely to break
  users code—the code would have to be depending on the absence of these values in Continued-As-New Runs.]_

  This update also have various fixes and features:

  - Don't dispatch eager activity if task queue is not the "current" ([temporalio/sdk-core#397](https://github.com/temporalio/sdk-core/pull/397))
  - Fix cancelling of started-but-lang-doesn't-know workflows ([temporalio/sdk-core#379](https://github.com/temporalio/sdk-core/pull/379))
  - Protect worker from more network errors ([temporalio/sdk-core#396](https://github.com/temporalio/sdk-core/pull/396))
  - Use tokio-rustls for request ([temporalio/sdk-core#395](https://github.com/temporalio/sdk-core/pull/395))
  - Fix for ephemeral test server zombie ([temporalio/sdk-core#392](https://github.com/temporalio/sdk-core/pull/392))
  - Ephemeral server lazy-downloader and runner ([temporalio/sdk-core#389](https://github.com/temporalio/sdk-core/pull/389))
  - Fix health service getter ([temporalio/sdk-core#387](https://github.com/temporalio/sdk-core/pull/387))
  - Expose HealthService ([temporalio/sdk-core#386](https://github.com/temporalio/sdk-core/pull/386))
  - Add more missing workflow options and add request_id as parameter for some calls ([temporalio/sdk-core#365](https://github.com/temporalio/sdk-core/pull/365))
  - Correct API definition link ([temporalio/sdk-core#381](https://github.com/temporalio/sdk-core/pull/381))
  - Add grpc health checking service/fns to client ([temporalio/sdk-core#377](https://github.com/temporalio/sdk-core/pull/377))
  - Respect per-call gRPC headers ([temporalio/sdk-core#375](https://github.com/temporalio/sdk-core/pull/375))
  - More client refactoring & add versioning-opt-in config flag ([temporalio/sdk-core#374](https://github.com/temporalio/sdk-core/pull/374))
  - Publicly expose the new client traits ([temporalio/sdk-core#371](https://github.com/temporalio/sdk-core/pull/371))
  - Add Test Server client & update deps ([temporalio/sdk-core#370](https://github.com/temporalio/sdk-core/pull/370))
  - Added test confirming act. w/o heartbeats times out ([temporalio/sdk-core#369](https://github.com/temporalio/sdk-core/pull/369))
  - Add Operator API machinery to client ([temporalio/sdk-core#366](https://github.com/temporalio/sdk-core/pull/366))

- [`client`] Only require `signalArgs` in [`signalWithStart`](https://typescript.temporal.io/api/classes/client.workflowclient/#signalwithstart) when needed ([#847](https://github.com/temporalio/sdk-typescript/pull/847))

### Features

- :boom: Improvements to `@temporalio/testing` ([#865](https://github.com/temporalio/sdk-typescript/pull/865) and [#873](https://github.com/temporalio/sdk-typescript/pull/873))

  BREAKING CHANGE: Breaking for the testing package in some of the more advanced and rarely used options:

  - No longer accepting `runInNormalTime` when waiting for workflow result
  - `TestWorkflowEnvironmentOptions` is completely redone

  _[Given that these were rarely used and the testing package isn't meant for production use, we don't think this change warrants a major version bump.]_

  `TestWorkflowEnvironment.create` is deprecated in favor of:

  - [`TestWorkflowEnvironment.createTimeSkipping`](https://typescript.temporal.io/api/classes/testing.TestWorkflowEnvironment#createtimeskipping)
  - [`TestWorkflowEnvironment.createLocal`](https://typescript.temporal.io/api/classes/testing.TestWorkflowEnvironment#createlocal)

  Added [`TestWorkflowEnvironment.currentTimeMs`](https://typescript.temporal.io/api/classes/testing.TestWorkflowEnvironment#currenttimems).

- Various minor features ([#865](https://github.com/temporalio/sdk-typescript/pull/865))
  - Add [`Connection.healthService`](https://typescript.temporal.io/api/classes/client.Connection#healthservice) and generate testservice and health in proto package
  - Updated ci to use sdk-ci namespace for testing with cloud.
  - Use ephemeral server from Core (supports both time skipping and temporalite)
  - Test server is now only downloaded on first use
  - Removed some unused dependencies
  - Refactored core bridge into multiple files
  - Closes [#834](https://github.com/temporalio/sdk-typescript/issues/834)
  - Closes [#844](https://github.com/temporalio/sdk-typescript/issues/844)
- [`client`] Add a high-level meta [`Client`](https://typescript.temporal.io/api/classes/client.Client) class ([#870](https://github.com/temporalio/sdk-typescript/pull/870))

  We now recommend using this instead of our other clients:

  ```ts
  import { Client } from '@temporalio/client';

  const client = new Client(options);

  await client.workflow.start();
  await client.activity.heartbeat();
  await client.activity.complete();
  ```

  - `client.workflow` is a [`WorkflowClient`](https://typescript.temporal.io/api/classes/client.workflowclient/).
  - `client.activity` is an [`AsyncCompletionClient`](https://typescript.temporal.io/api/classes/client.asynccompletionclient/).
  - We will be adding `client.schedule.*` (see the [`ScheduleClient` proposal](https://github.com/temporalio/proposals/pull/62)).

- Add [`ActivityOptions.allowEagerDispatch`](https://typescript.temporal.io/api/interfaces/common.activityoptions/#alloweagerdispatch) (default true) ([#873](https://github.com/temporalio/sdk-typescript/pull/873))
- [`testing`] Use `temporal.download` for downloading test server ([#864](https://github.com/temporalio/sdk-typescript/pull/864))
- Add Webpack rule to auto instrument Workflows for code coverage, add `augmentWorkerOptions()` ([#858](https://github.com/temporalio/sdk-typescript/pull/858), thanks to [`@vkarpov15`](https://github.com/vkarpov15) 🙏)

### Documentation

- Improve API reference ([#871](https://github.com/temporalio/sdk-typescript/pull/871))
- Publish unchanged packages ([#862](https://github.com/temporalio/sdk-typescript/pull/862))
- Update `nyc-test-coverage` README ([#866](https://github.com/temporalio/sdk-typescript/pull/866))

### Miscellaneous Tasks

- In-process verdaccio server ([#861](https://github.com/temporalio/sdk-typescript/pull/861), thanks to [`@mjameswh`](https://github.com/mjameswh) 🙏)

## [1.2.0] - 2022-09-01

### Features

- [`client`] Enable gRPC keep-alive by default ([#855](https://github.com/temporalio/sdk-typescript/pull/855))
- Implement entrypoint for debug replayer ([#848](https://github.com/temporalio/sdk-typescript/pull/848))

### Bug Fixes

- Build `nyc-test-coverage` package, fixes [#839](https://github.com/temporalio/sdk-typescript/issues/839) ([#843](https://github.com/temporalio/sdk-typescript/pull/843))
- [`workflow`] Fix non-determinism on replay when using a `patched` statement in a `condition` ([#859](https://github.com/temporalio/sdk-typescript/pull/859))
- `isCancellation` no longer scans chain recursively ([#837](https://github.com/temporalio/sdk-typescript/pull/837))
- Don't trigger conditions for query jobs ([#854](https://github.com/temporalio/sdk-typescript/pull/854))

### Documentation

- Add title and link to other docs ([#842](https://github.com/temporalio/sdk-typescript/pull/842))
- Update release instructions ([#835](https://github.com/temporalio/sdk-typescript/pull/835))
- Update README badge links ([#856](https://github.com/temporalio/sdk-typescript/pull/856))

## [1.1.0] - 2022-08-20

### Bug Fixes

- :boom: [`worker`] Remove unnecessary `ReplayWorkerOptions` ([#816](https://github.com/temporalio/sdk-typescript/pull/816))

  BREAKING CHANGE: While this is technically breaking (if you pass options that are irrelevant to replay like `maxActivitiesPerSecond`, you'll get a compilation error), we decided it did not warrant a major version bump, as it doesn't affect production code (replay is a testing feature) and is only a type change (is caught at compile type by TS users and doesn't affect JS users).

- Warn instead of throwing when getting `workflowBundle` with `workflowsPath` and `bundlerOptions` ([#833](https://github.com/temporalio/sdk-typescript/pull/833))

  ⚠️ NOTE: We now prefer taking `workflowBundle` over `workflowsPath` when both are provided, which is the correct behavior and what users should expect.

  We also now warn that workflow interceptors are ignored when using `workflowBundle`.

- [`workflow`] Make breakpoints work inside workflow isolate context ([#819](https://github.com/temporalio/sdk-typescript/pull/819))

  ⚠️ NOTE: Bundles created with `bundleWorkflowCode` should only be used for calling `Worker.create` when the exact same version of `@temporalio/worker` is used. (If you don't pin to exact versions in your `package.json`, then you should use a lockfile, and both the machine that runs `bundleWorkflowCode` and `Worker.create` should run `npm ci`, not `npm install`.)

  ⚠️ DEPRECATION: `sourceMap` and `sourceMapPath` are now deprecated. We've inlined source maps, so now this works:

  ```ts
  const { code } = await bundleWorkflowCode({ workflowsPath });
  const worker = await Worker.create({ workflowBundle: { code }, ...otherOptions });
  ```

- Avoid using dynamic import in `@temporalio/testing` ([#805](https://github.com/temporalio/sdk-typescript/pull/805))
- [`worker`] Don't start activity poller if no activities registered ([#808](https://github.com/temporalio/sdk-typescript/pull/808))
- Update `proto3-json-serializer` to `^1.0.3` ([#809](https://github.com/temporalio/sdk-typescript/pull/809))
- Help protobufjs find `long` in Yarn3 ([#810](https://github.com/temporalio/sdk-typescript/issues/810)) ([#814](https://github.com/temporalio/sdk-typescript/pull/814))
- Add `@types/long` to client ([#735](https://github.com/temporalio/sdk-typescript/pull/735))
- [`worker`] Improve worker default options heuristics ([#802](https://github.com/temporalio/sdk-typescript/pull/802))
- Use `GITHUB_TOKEN` in `create-project` for CI ([#721](https://github.com/temporalio/sdk-typescript/pull/721))

### Features

- :boom: [`worker`] Add webpack configuration, closes [#537](https://github.com/temporalio/sdk-typescript/issues/537) ([#815](https://github.com/temporalio/sdk-typescript/pull/815))

  This was our most-upvoted feature request! ([9 👍's](https://github.com/temporalio/sdk-typescript/issues?q=is%3Aissue+sort%3Areactions-%2B1-desc).) See [`WorkerOptions.bundlerOptions.webpackConfigHook`](https://typescript.temporal.io/api/interfaces/worker.workeroptions/#bundleroptions) for usage.

  BREAKING CHANGE: If you provide both `workflowBundle` & `workflowsPath` or both `workflowBundle` & `bundlerOptions` to `Worker.create`, a `ValueError` will now be thrown. While this is technically breaking, TODO

- Add `@temporalio/nyc-test-coverage` package ([#798](https://github.com/temporalio/sdk-typescript/pull/798), thanks to [`@vkarpov15`](https://github.com/vkarpov15) 🙏)

  This package adds code coverage for Istanbul. It's currently in beta: the API may be unstable as we gather feedback on it from users. To try it out, see [this code snippet](https://github.com/temporalio/sdk-typescript/pull/798#issue-1323652976) for current usage.

- [`common`] Improve `ApplicationFailure` arguments; add `.create` and `.fromError` ([#767](https://github.com/temporalio/sdk-typescript/pull/767))

  See [`ApplicationFailure.create`](https://typescript.temporal.io/api/classes/common.applicationfailure/#create) and [`ApplicationFailure.fromError`](https://typescript.temporal.io/api/classes/common.applicationfailure/#fromerror)

- Expose additional console methods to workflow context ([#831](https://github.com/temporalio/sdk-typescript/pull/831))

  `console.[error|warn|info|debug]` can now be called from Workflow code, in addition to `console.log`

### Documentation

- Add package list to README ([#803](https://github.com/temporalio/sdk-typescript/pull/803))
- Add API doc for `bundleWorkflowCode`, fixes [#792](https://github.com/temporalio/sdk-typescript/issues/792) ([#793](https://github.com/temporalio/sdk-typescript/pull/793))
- Surface missing core-bridge exports ([#812](https://github.com/temporalio/sdk-typescript/pull/812))
- Export missing `ApplicationFailureOptions` ([#823](https://github.com/temporalio/sdk-typescript/pull/823))
- Improve API reference ([#826](https://github.com/temporalio/sdk-typescript/pull/826))

## [1.0.1] - 2022-07-29

### Bug Fixes

- Allow `RetryPolicy.maximumAttempts: Number.POSITIVE_INFINITY` ([#784](https://github.com/temporalio/sdk-typescript/pull/784))
- [`worker`] Prevent ending a worker span twice. ([#786](https://github.com/temporalio/sdk-typescript/pull/786))
- Update Core SDK ([#790](https://github.com/temporalio/sdk-typescript/pull/790))
  - Turn down log level for this line ([#362](https://github.com/temporalio/sdk-core/pull/362))
  - Fix bug where LA resolutions could trigger activations with no associated WFT ([#357](https://github.com/temporalio/sdk-core/pull/357))
  - Don't allow activity completions with unset successful result payloads ([#356](https://github.com/temporalio/sdk-core/pull/356))
  - Make sure workers do not propagate retryable errors as fatal ([#353](https://github.com/temporalio/sdk-core/pull/353))
  - Fix null LA results becoming unparseable ([#355](https://github.com/temporalio/sdk-core/pull/355))

### Documentation

- Update release instructions ([#779](https://github.com/temporalio/sdk-typescript/pull/779))
- Update release instructions again ([#780](https://github.com/temporalio/sdk-typescript/pull/780))

### Features

- [`workflow`] List registered queries in error response when a query is not found ([#791](https://github.com/temporalio/sdk-typescript/pull/791))

### Miscellaneous Tasks

- Upgrade to protobufjs v7 ([#789](https://github.com/temporalio/sdk-typescript/pull/789))
  - Fixes [#669](https://github.com/temporalio/sdk-typescript/issues/669)
  - Fixes [#785](https://github.com/temporalio/sdk-typescript/issues/785)

## [1.0.0] - 2022-07-25

⚠️ NOTE: Before upgrading to `1.0.0`, note all breaking changes between your current version and this version, including [`1.0.0-rc.1`](#100-rc1---2022-07-11) and [`1.0.0-rc.0`](#100-rc0---2022-06-17).

### Bug Fixes

- [`worker`] Update `terser`, fixes [#759](https://github.com/temporalio/sdk-typescript/issues/759) ([#760](https://github.com/temporalio/sdk-typescript/pull/760))
- Reference local version of `ActivityCancellationType` ([#768](https://github.com/temporalio/sdk-typescript/pull/768))

### Documentation

- Update author and license company name ([#748](https://github.com/temporalio/sdk-typescript/pull/748))
- Deprecate `temporalio` meta package ([#747](https://github.com/temporalio/sdk-typescript/pull/747))

### Refactor

- :boom: [`workflow`] Move `TaskInfo` to `WorkflowInfo` ([#761](https://github.com/temporalio/sdk-typescript/pull/761))

  BREAKING CHANGE: There is no longer a `taskInfo()` export from `@temporalio/workflow`. `taskInfo().*` fields have been moved to `workflowInfo()`.

- :boom: Update `activity` and `worker` exports ([#764](https://github.com/temporalio/sdk-typescript/pull/764))

  BREAKING CHANGE: If you were importing any of the following errors from `@temporalio/activity` (unlikely), instead import from `@temporalio/common`: `ValueError, PayloadConverterError, IllegalStateError, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError`

## [1.0.0-rc.1] - 2022-07-11

### Bug Fixes

- Ignore source map parse errors ([#710](https://github.com/temporalio/sdk-typescript/pull/710))
- [`workflow`] ExecuteChild returns `Promise<WorfkflowResultType<T>>` ([#718](https://github.com/temporalio/sdk-typescript/pull/718))
- Simplify DocBreadcrumbs so we don't need the swizzle warning comment ([#715](https://github.com/temporalio/sdk-typescript/pull/715))
- Add missing deps ([#733](https://github.com/temporalio/sdk-typescript/pull/733))

  - `@opentelemetry/api` was missing from `@temporalio/common/lib/internal-non-workflow`

- Re-export from internal-workflow-common ([#736](https://github.com/temporalio/sdk-typescript/pull/736))
- [`activity`] Set Info.isLocal correctly ([#714](https://github.com/temporalio/sdk-typescript/pull/714))
- [`worker`] Disallow importing non-Workflow @temporalio packages ([#722](https://github.com/temporalio/sdk-typescript/pull/722))
- [`bundler`] Avoid 'package source-map-loader not found' in PNPM ([#737](https://github.com/temporalio/sdk-typescript/pull/737))
- Default searchAttributes to {} and edit type ([#738](https://github.com/temporalio/sdk-typescript/pull/738))
- Fix bug where cancelled workflow commands were unnecessarily sent to the server ([#745](https://github.com/temporalio/sdk-typescript/pull/745))

  - Upgrade core submodule to get the fix: https://github.com/temporalio/sdk-core/pull/351
  - Fixes [#731](https://github.com/temporalio/sdk-typescript/pull/731)

- Fix nightly and activity failing with non ApplicationFailure ([#751](https://github.com/temporalio/sdk-typescript/pull/751))

### Documentation

- Document ParentClosePolicy, ChildWorkflowCancellationType, and WorkflowIdReusePolicy ([#716](https://github.com/temporalio/sdk-typescript/pull/716))
- Fix Connection.connect in CHANGELOG ([#723](https://github.com/temporalio/sdk-typescript/pull/723))
- Remove beta section from README
- Don't load Algolia API key from env ([#726](https://github.com/temporalio/sdk-typescript/pull/726))
- Review API docs ([#744](https://github.com/temporalio/sdk-typescript/pull/744))

### Features

- Support history from JSON ([#743](https://github.com/temporalio/sdk-typescript/pull/743))
- Improve activity registration and proxy types ([#742](https://github.com/temporalio/sdk-typescript/pull/742))

  - Closes #655
  - Deprecates `ActivityInterface` - replaced with `UntypedActivities`
  - `proxyActivities` and (the experimental) `proxyLocalActivities` signature changed to provide better type safety when referencing non-existing activities
  - `WorkerOptions.activities` type is now `object` to allow arbitrary class registration

  NOTE: This is **not** a backwards incompatible change

- Revise SDK log attributes and levels ([#750](https://github.com/temporalio/sdk-typescript/pull/750))

  Adds 2 new default interceptors: `WorkflowInboundLogInterceptor` and `ActivityInboundLogInterceptor` and a default
  logger sink to provide better logging experience out of the box.

  Also reduced the severity of internal SDK logs to `trace` level to reduce log noise.

  Closes [#461](https://github.com/temporalio/sdk-typescript/pull/461)

### Miscellaneous Tasks

- Remove unused deps; Upgrade protobufjs; Publish src ([#719](https://github.com/temporalio/sdk-typescript/pull/719))

  Bugfixes:

  - Clear logs from CoreLogger buffer after flushing
  - Closes [#717](https://github.com/temporalio/sdk-typescript/pull/717)

- Add more build artifacts for debugging ([#749](https://github.com/temporalio/sdk-typescript/pull/749))

## [1.0.0-rc.0] - 2022-06-17

### Bug Fixes

- :boom: Use firstExecutionRunId and signaledRunId instead of originalRunId ([#664](https://github.com/temporalio/sdk-typescript/pull/664))

  `originalRunId` is a concept related to resetting workflows. None of the instances of `originalRunId` in the SDK seem to do with resetting, so they were changed to `firstExecutionRunId` and `signaledRunId` for handles returned by `WorkflowClient.start` / `@temporalio/workflow:startChild` and `WorkflowClient.signalWithStart` respectively.

- :boom: Use error constructor name as `applicationFailureInfo.type` ([#683](https://github.com/temporalio/sdk-typescript/pull/683))

  Now uses `err.constructor.name` instead of `err.name` by default, since `.name` is still 'Error' for classes that extend Error.

- Various improvements and fixes ([#660](https://github.com/temporalio/sdk-typescript/pull/660))

  - Record memory usage in stress tests
  - Run nightly at night (PST)
  - Don't block runtime loop when creating new client
  - Don't include proto converter in test workflows `index.ts` - cuts the **test** bundle size by half
  - Fix inflight activity tracking
  - Expose `WorkerStatus.numHeartbeatingActivities`
  - Handle ShutdownError by name - closes [#614](https://github.com/temporalio/sdk-typescript/pull/614)
  - Fix TS initiated activity cancellation not creating a proper `ApplicationFailure`
  - Closes [#667](https://github.com/temporalio/sdk-typescript/pull/667)

- Validate that RetryPolicy maximumAttempts is an integer ([#674](https://github.com/temporalio/sdk-typescript/pull/674))

  Added a quick check that `maximumAttempts` is a number using [`Number.isInteger()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/isInteger). This check explicitly excludes numbers like 3.1415 and `Number.POSITIVE_INFINITY`.

  `maximumAttempts` should always be an integer, doesn't make much sense for it to have a decimal component. And `maximumAttempts = 0` is the preferred alternative for `maximumAttempts = Number.POSITIVE_INFINITY`.

- Use JSON.stringify() for non-error objects and String() for other values ([#681](https://github.com/temporalio/sdk-typescript/pull/681))
- [`workflow`] Import @temporalio/common ([#688](https://github.com/temporalio/sdk-typescript/pull/688))

  - Fixes [#687](https://github.com/temporalio/sdk-typescript/pull/687)

- [`worker`] Throw error when importing a node built-in module from a Workflow ([#689](https://github.com/temporalio/sdk-typescript/pull/689))

  - Closes [#685](https://github.com/temporalio/sdk-typescript/issues/685)

- Recreate TransportErrors in initial connection to provide better stack traces ([#693](https://github.com/temporalio/sdk-typescript/pull/693))
- [`docs`] Add links to API and other categories ([#676](https://github.com/temporalio/sdk-typescript/pull/676))
- [`docs`] `Connection.service` -> `.workflowService` ([#696](https://github.com/temporalio/sdk-typescript/pull/696))
- [`docs`] Remove maxIsolateMemoryMB ([#700](https://github.com/temporalio/sdk-typescript/pull/700))
- Don't drop details from core errors ([#705](https://github.com/temporalio/sdk-typescript/pull/705))

### Features

- [`worker`] Upgrade neon to 0.10 ([#675](https://github.com/temporalio/sdk-typescript/pull/675))
- :boom: Do not allow undefined in PayloadConverter.toPayload ([#672](https://github.com/temporalio/sdk-typescript/pull/672))

  BREAKING CHANGE: `PayloadConverter.toPayload` can no longer return `undefined`.

  NOTE: This change doesn't apply to `PayloadConverterWithEncoding.toPayload` where the function should return `undefined` to mark that the converter doesn't handle a value.

- :boom: Add upsertSearchAttributes and more ([#657](https://github.com/temporalio/sdk-typescript/pull/657))

  - Added and changed `WorkflowInfo` fields
  - Added `taskInfo` function to `@temporalio/workflow`
  - `Datetime` search attributes are converted to Date objects
  - Add `upsertSearchAttributes` Workflow function
  - Make Search Attributes always arrays

  - Fixes [#314](https://github.com/temporalio/sdk-typescript/pull/314)
  - Fixes [#445](https://github.com/temporalio/sdk-typescript/pull/445)
  - Closes [#576](https://github.com/temporalio/sdk-typescript/pull/576)
  - Closes [#357](https://github.com/temporalio/sdk-typescript/pull/357)

- :boom: Eager and lazy Connection variants + static metadata + worker shutdown refactor ([#682](https://github.com/temporalio/sdk-typescript/pull/682))

- Upgrade to latest sdk-core
- Fix test-payload-converter not awaiting on promises
- Simplify Connection metadata API and support static metadata
- Deprecate `NativeConnection.create` in favor of `connect` method
- Add lint rule: `@typescript-eslint/no-floating-promises`
- Close `TestEnvironment.nativeConnection` in `teardown` method

  BREAKING CHANGE:

  - `Connection` constructor is no longer public, and is replaced with `async Connection.connect` and `Connection.lazy` factory methods.
  - `Connection.service` was renamed `Connection.workflowService`
  - `WorkflowClient` constructor now accepts a single options param

    BEFORE:

    ```ts
    const connection = new Connection(...);
    const client = new WorkflowClient(connection.service, options);
    ```

    AFTER:

    ```ts
    const connection = await Connection.connect(...);
    const client = new WorkflowClient({ connection, ...options });
    ```

  - Added `Connection.close` and made `Connection.client` protected

    NOTE: It is recommended to reuse `Connection` instances as much as possible.
    When done using a `Connection`, call `close()` to release any resources held by it.

  - `LOCAL_DOCKER_TARGET` constant was renamed `LOCAL_TARGET`

  - Metrics are now emitted with the `temporal_` prefix by default to be consistent with other SDKs, in the near future this can be disabled by setting `TelemetryOptions.noTemporalPrefixForMetrics` to `true`.

  - Closes [#607](https://github.com/temporalio/sdk-typescript/pull/607)
  - Closes [#677](https://github.com/temporalio/sdk-typescript/pull/677)
  - Closes [#452](https://github.com/temporalio/sdk-typescript/pull/452)

- :boom: Implement stack trace query ([#690](https://github.com/temporalio/sdk-typescript/pull/690))

  - Improved stack traces for workflows
  - Closes [#167](https://github.com/temporalio/sdk-typescript/pull/167)
  - Stack trace query works on node `>=16.14` because is depends on the [V8 promise hooks API](https://nodejs.org/api/v8.html#promise-hooks)
  - `@temporalio/worker` now depends on `source-map` and `source-map-loader`

  BREAKING CHANGE: `WorkerOptions.workflowBundle` now accepts both code and source maps

  Before:

  ```ts
  await Worker.create({
    workflowBundle: { code },
    ...rest,
  });

  // -- OR --

  await Worker.create({
    workflowBundle: { path },
    ...rest,
  });
  ```

  After:

  ```ts
  await Worker.create({
    workflowBundle: { code, sourceMap },
    ...rest
  })

  // -- OR --

  await Worker.create({
    workflowBundle: { codePath, sourceMapPath }
    ...rest
  })
  ```

  The return value of `bundleWorkflowCode` is now `{ code: string, sourceMap: string }`

  BREAKING CHANGE: `WorkflowInternalsInterceptor.activate` is now synchronous

- Support Jest mock Activity functions ([#704](https://github.com/temporalio/sdk-typescript/pull/704))
- [`worker`] Add `runUntil` method ([#703](https://github.com/temporalio/sdk-typescript/pull/703))

  Useful helper especially in tests.

  Usage:

  ```ts
  const worker = await Worker.create(opts);

  // Wait on an async function
  await worker.runUntil(async () => {
    client.execute(someWorkflow, wopts);
  });

  // -- OR --

  // Wait on a promise
  await worker.runUntil(client.execute(someWorkflow, wopts));
  ```

- :boom: [`worker`] Rename headers to metadata for `NativeConnection` ([#706](https://github.com/temporalio/sdk-typescript/pull/706))

  To use the same term as `@temporalio/client.Connection`

  BREAKING CHANGE:

  - `NativeConnectionOptions.headers` was renamed to `NativeConnectionOptions.metadata`
  - `NativeConnection.updateHeaders` was renamed to `NativeConnection.updateMetadata`

### Miscellaneous Tasks

- Address feedback from connection refactor PR ([#686](https://github.com/temporalio/sdk-typescript/pull/686))
- Upgrade to latest Core ([#701](https://github.com/temporalio/sdk-typescript/pull/701))

  - Closes [#697](https://github.com/temporalio/sdk-typescript/pull/697)
  - Exposes `operatorService` on client `Connection`

- Build bridge for arm linux ([#698](https://github.com/temporalio/sdk-typescript/pull/698))

### Refactor

- Make SearchAttributesValue an array ([#692](https://github.com/temporalio/sdk-typescript/pull/692))

### Testing

- Reduce smorgasbord timeout sensitivity for CI ([#673](https://github.com/temporalio/sdk-typescript/pull/673))
- Write to provided worker memory log file ([#680](https://github.com/temporalio/sdk-typescript/pull/680))

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

  BREAKING CHANGE: [`DataConverter`](https://typescript.temporal.io/api/interfaces/worker.DataConverter) interface has changed, and some things that were exported from `common` no longer are. If it's no longer exported (see [list of exports](https://typescript.temporal.io/api/namespaces/common)), try importing from `@temporalio/activity|client|worker|workflow`. If you're unable to find it, open an issue for us to fix it, and in the meantime import from [`internal-workflow-common`](https://github.com/temporalio/sdk-typescript/tree/main/packages/common/lib/internal-workflow) or [`internal-non-workflow-common`](https://github.com/temporalio/sdk-typescript/tree/main/packages/common/lib/internal-non-workflow).

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

- Support [`ms`](https://www.npmjs.com/package/ms)-formatted string for activity.Context.sleep ([#322](https://github.com/temporalio/sdk-typescript/pull/322))
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
