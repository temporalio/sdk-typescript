# `@temporalio/common`

[![NPM](https://img.shields.io/npm/v/@temporalio/common?style=for-the-badge)](https://www.npmjs.com/package/@temporalio/common)

Part of [Temporal](https://temporal.io)'s TypeScript SDK (see [docs](https://docs.temporal.io/typescript/introduction/) and [samples](https://github.com/temporalio/samples-typescript)).

Common library for code that's used across the Client, Worker, and/or Workflow:

- [DataConverter docs](https://docs.temporal.io/typescript/data-converters)
- [Failure docs](https://docs.temporal.io/typescript/handling-failure)
- [API reference](https://typescript.temporal.io/api/namespaces/common)

## Automatic header codecs

Set `dataConverter.encodeHeaders: true` on both Clients and Workers to apply configured
`payloadCodecs` to payload-valued headers, including OpenTelemetry tracing headers.
This is opt-in and defaults to `false`.

Interceptor header APIs still accept `Payload` objects: serialize application values with your
configured payload converter, but do not apply codecs yourself when automatic processing is enabled.
Incoming headers are decoded before inbound interceptors run. Value-backed System Nexus headers
continue to use the configured payload converter; tracing retains its existing serialization.
Nexus string headers and gRPC metadata are not affected.

Remove any manual header codec processing before enabling this option. Existing histories and
schedules may contain plaintext headers, so your codecs must support decoding those headers if
you need to continue reading or replaying them. Codec failures are propagated, not retried as
plaintext. Schedule descriptions retain wire-format headers in `raw`; schedule updates decode
retained headers before encoding the updated action, so they are not encoded twice.
