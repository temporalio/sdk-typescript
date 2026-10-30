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
encoding. There is no client header-encoding option, so manually encoded client headers
are not encoded a second time. Workflow interceptors should produce serialized, unencoded
headers when enabling this worker option.

Use compatible codecs on receiving workers and replay workers. When replaying older
histories with plaintext headers, codecs must be able to decode those headers too.
Nexus string headers and gRPC metadata are unaffected.
