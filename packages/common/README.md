# `@temporalio/common`

[![NPM](https://img.shields.io/npm/v/@temporalio/common?style=for-the-badge)](https://www.npmjs.com/package/@temporalio/common)

Part of [Temporal](https://temporal.io)'s TypeScript SDK (see [docs](https://docs.temporal.io/typescript/introduction/) and [samples](https://github.com/temporalio/samples-typescript)).

Common library for code that's used across the Client, Worker, and/or Workflow:

- [DataConverter docs](https://docs.temporal.io/typescript/data-converters)
- [Failure docs](https://docs.temporal.io/typescript/handling-failure)
- [API reference](https://typescript.temporal.io/api/namespaces/common)

## Payload Caching

The Temporal SDKs can cache payloads to avoid unnecessary network traffic. The TypeScript SDK exposes a generic `PayloadCache` interface and provides an in-memory cache implementation that is used by default. Creating a custom cache or sharing a cache between clients and workers can be done by explicitly passing a payload cache in to clients and workers:

```ts
const payloadCache = new InMemoryPayloadCache({
  maxTotalBytes: 128 * 1024 * 1024,
  maxEntries: 20_000,
});

const client = new Client({ payloadCache });
const worker = await Worker.create({ taskQueue, workflowsPath, payloadCache });
```

n.b. The cache is a best-effort optimization.
n.b. External Storage is currently the only SDK feature that uses the payload cache.

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
