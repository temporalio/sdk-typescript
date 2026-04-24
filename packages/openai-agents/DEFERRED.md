# Deferred Features

Features considered but deferred from the initial release.

## StatefulMCPServerProvider

A provider for MCP servers that maintain connection state (e.g., SSE transports).
Unlike `StatelessMCPServerProvider` which creates/destroys connections per activity call,
a stateful provider would maintain persistent connections across the worker lifecycle.

**Why deferred:** Requires careful lifecycle management (connect on worker start, close on
shutdown), reconnection logic, and decisions about connection pooling. The stateless approach
covers most use cases with simpler semantics.

## nexusOperationAsTool

Wrap a Temporal Nexus operation as an agent tool, similar to `activityAsTool()`.
Would allow agents to invoke cross-namespace operations through Temporal's Nexus protocol.

**Why deferred:** The Nexus API surface is still stabilizing. Once settled, this is
a straightforward wrapper analogous to `activityAsTool`.

## testing.AgentEnvironment / ResponseBuilders

A higher-level testing API that provides a test-friendly `AgentEnvironment` for unit-testing
agent workflows without a running Temporal server. Would include response builders for
constructing complex `ModelResponse` objects (multi-tool, handoff chains, structured output).

**Why deferred:** The current `FakeModel` / `FakeModelProvider` / `GeneratorFakeModel` testing
utilities cover the critical path. A richer API can be added incrementally based on user feedback.

## Trace Interceptor

A Temporal interceptor that bridges OpenAI agent traces with Temporal's tracing infrastructure.
Would propagate trace context from workflow spans to model activity spans, enabling end-to-end
observability in distributed tracing backends (e.g., OpenTelemetry).

**Why deferred:** Tracing is currently disabled in workflow context (`tracingDisabled: true` in
the runner). Enabling it requires decisions about trace propagation format, integration with
Temporal's existing OpenTelemetry interceptors, and how to handle trace data across the
workflow/activity boundary.
