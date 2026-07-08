<!--
High-level release notes.
Loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

When your PR includes a user-facing change, add an entry below under the
appropriate heading (create the heading if it does not yet exist). Within
each heading content can be free-form. Feel free to include examples, links
to docs, or any other relevant information.

### Added            — new features
### Changed          — changes in existing functionality
### Deprecated       — soon-to-be-removed features
### Breaking Changes — removed or backwards-incompatible features
### Fixed            — notable bug fixes
### Security         — notable security fixes
-->

# Changelog

## [1.19.0]

### Added

- Nexus operation link propagation for signals. When a Nexus operation handler signals a workflow
  (including signal-with-start), the inbound Nexus request links are now forwarded onto the signaled
  workflow so its history events link back to the caller, and the link the server returns for the
  signaled event is attached to the caller workflow's Nexus operation history event. This makes the
  caller and callee mutually navigable in the UI for signal-based Nexus operations.
- Added `@temporalio/interceptors-opentelemetry-v2` to support OpenTelemetry JS SDK 2.
- Expose continue-as-new backoff start interval.
- add nondeterministic `unsafe.random` for read-only contexts.

### Breaking Changes

- `WorkflowHandle.runId` in `@temporalio/nexus` is now an optional property to support creating a handle using only a workflow ID.
- Enable gRPC gzip compression by default. Can be disabled by passing `grpcCompression: { codec: none }` when constructing a `NativeConnection`.
- bump required Node version to 20.3.0.

### Changed

- Standalone Nexus operation links are now formatted to align with server side support.
- Standalone Nexus operation links are now forwarded on start workflow and signal requests.
- `protobufjs` bumped to 7.6.2
- Rename @temporalio/openai-agents tracing sink to the reserved \__temporal_ prefix

### Fixed

- fix(openai-agents): correct misleading legacy-query comment in resolveQueryKey
- avoid logging `NativeConnection` on worker startup

## [1.20.0]

### Added

- New `@temporalio/langsmith` package for tracing Temporal apps to [LangSmith](https://smith.langchain.com/).
  It hooks the client, Workflow, and Activity interceptors so a Workflow and the Activities it runs show up
  as a single LangSmith run tree.

### Changed

- protobufjs bumped to ^7.6.4
- Updated Core to `5df57f6d`. Package-visible changes from this update include:
  - `NativeConnection` initialization now retries without gRPC gzip compression if the server
    cannot decompress the eager `GetSystemInfo` call.
  - Workflow replay now honors SDK flags already recorded in history even when the server does not
    advertise SDK metadata support.
  - OTLP metric export failures from Core's periodic metric reader are now logged through Core
    telemetry.
- `@temporalio/openai-agents`: Query handlers and update validators now derive trace span IDs from the SDK's
  replay-safe random source instead of a private seeded PRNG. This removes the old seed-collision workaround
  and gives read-only handlers distinct, well-formed span IDs.

## 1.20.1

### Fixed

- patch workflow bundles with const/let/var that are emitted by webpack 5.108.0 and above

## 1.20.2

### Fixed

- fix(langsmith): resolve workflow interceptor module by absolute path

## [Unreleased]
