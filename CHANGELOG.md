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

## [Unreleased]

### Fixed

- Workflow Bundler: further strengthening of the `__webpack_module_cache__` replacement logic, addressing regressions introduced by the fix in 1.19.1.

## [1.19.1] - 2026-07-07

### Fixed

- Workflow Bundler: fix a bug in our replacement of `__webpack_module_cache__` logic introduced by webpack 5.108.0, resulting in breaking workflow context isolation (fix #2170).

## [1.19.0] - 2026-07-01

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
