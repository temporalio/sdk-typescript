# `@temporalio/common`

[![NPM](https://img.shields.io/npm/v/@temporalio/common?style=for-the-badge)](https://www.npmjs.com/package/@temporalio/common)

Part of [Temporal](https://temporal.io)'s TypeScript SDK (see [docs](https://docs.temporal.io/typescript/introduction/) and [samples](https://github.com/temporalio/samples-typescript)).

Common library for code that's used across the Client, Worker, and/or Workflow:

- [DataConverter docs](https://docs.temporal.io/typescript/data-converters)
- [Failure docs](https://docs.temporal.io/typescript/handling-failure)
- [API reference](https://typescript.temporal.io/api/namespaces/common)

## Payload Caching

**Experimental.** Clients and Workers can cache External Storage payloads, so a payload already in the cache is not retrieved from its storage driver again. Caching is off by default. The SDK exposes a generic `PayloadCache` interface and an in-memory implementation, `InMemoryPayloadCache`, exported from `@temporalio/client` and `@temporalio/worker`. Pass a payload cache to clients and workers to enable caching, or pass the same cache to both to share it:

```ts
import { Client, InMemoryPayloadCache } from '@temporalio/client';
import { Worker } from '@temporalio/worker';

const payloadCache = new InMemoryPayloadCache({
  maxTotalBytes: 128 * 1024 * 1024,
  maxEntries: 20_000,
});

const client = new Client({ payloadCache });
const worker = await Worker.create({ taskQueue, workflowsPath, payloadCache });
```

n.b. The cache is a best-effort optimization.

### External Storage

External Storage caches the final encoded `Payload` given to a storage driver. Cache hits do not call the storage driver. The reference payload claim data is used to construct the cache key through the following steps:

1. UTF-8 encode the driver name and every claim key and value without normalization.
2. Sort claim keys by unsigned lexicographic order of their UTF-8 bytes.
3. Encode each string as its ASCII base-10 UTF-8 byte length, `:`, then the original string.
4. Prefix the key with `v0/temporal/extstore/`.
5. Concatenate the encoded driver name, then each sorted claim key and value.

For driver `aws-s3` and claim data `{ bucket: "abc", key: "1" }`, the key is:

```text
v0/temporal/extstore/6:aws-s36:bucket3:abc3:key1:1
```

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
