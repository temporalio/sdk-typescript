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

### Added

- Nexus operation link propagation for signals. When a Nexus operation handler signals a workflow
  (including signal-with-start), the inbound Nexus request links are now forwarded onto the signaled
  workflow so its history events link back to the caller, and the link the server returns for the
  signaled event is attached to the caller workflow's Nexus operation history event. This makes the
  caller and callee mutually navigable in the UI for signal-based Nexus operations.

- `@temporalio/openai-agents` now supports streaming. Passing `{ stream: true }` to `run()` streams an
  agent's model events from the Workflow to an outside subscriber over a Workflow Stream topic (set via
  `modelParams.streamingTopic`), matching the shape of the Python SDK. Requires `@temporalio/workflow-streams`.

- New `@temporalio/langsmith` package for tracing Temporal apps to [LangSmith](https://smith.langchain.com/).
  It hooks the client, Workflow, and Activity interceptors so a Workflow and the Activities it runs show up
  as a single LangSmith run tree.

### Changed

- `@temporalio/openai-agents`: Query handlers and update validators now derive trace span IDs from the SDK's
  replay-safe random source instead of a private seeded PRNG. This removes the old seed-collision workaround
  and gives read-only handlers distinct, well-formed span IDs.

### Breaking Changes

- `WorkflowHandle.runId` in `@temporalio/nexus` is now an optional property to support creating a handle using only a workflow ID.
