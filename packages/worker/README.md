# `@temporalio/worker`

[![NPM](https://img.shields.io/npm/v/@temporalio/worker?style=for-the-badge)](https://www.npmjs.com/package/@temporalio/worker)

Part of [Temporal](https://temporal.io)'s [TypeScript SDK](https://docs.temporal.io/typescript/introduction/).

- [Worker docs](https://docs.temporal.io/typescript/workers)
- [API reference](https://typescript.temporal.io/api/namespaces/worker)
- [Sample projects](https://github.com/temporalio/samples-typescript)

## Header codecs

Set `codecHeaders: true` on a Worker to use its configured payload codecs for headers:
incoming Workflow and Activity headers are decoded before interceptors run, and headers
emitted by Workflows are encoded before being sent to the server. This includes tracing
headers and defaults to `false`.

Client APIs continue to accept complete, wire-ready `Payload` headers, including any codec
encoding. Client APIs do not apply codecs to these Payloads, so manually encoded client headers
are not encoded a second time. Workflow interceptors should produce serialized, unencoded
headers when enabling this worker option.

TypeScript OpenTelemetry plugins (v1 and v2) can separately set `encodeClientHeaders: true`
to encode only their own client tracing carrier using the configured client codecs.
This does not affect other client headers or enable worker header processing.

Use compatible codecs on receiving workers and replay workers. When replaying older
histories with plaintext headers, codecs must be able to decode those headers too.
Nexus string headers and gRPC metadata are unaffected.
