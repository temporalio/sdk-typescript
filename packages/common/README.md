# `@temporalio/common`

[![NPM](https://img.shields.io/npm/v/@temporalio/common?style=for-the-badge)](https://www.npmjs.com/package/@temporalio/common)

Part of [Temporal](https://temporal.io)'s TypeScript SDK (see [docs](https://docs.temporal.io/typescript/introduction/) and [samples](https://github.com/temporalio/samples-typescript)).

Common library for code that's used across the Client, Worker, and/or Workflow:

- [DataConverter docs](https://docs.temporal.io/typescript/data-converters)
- [Failure docs](https://docs.temporal.io/typescript/handling-failure)
- [API reference](https://typescript.temporal.io/api/namespaces/common)

## Payload Caching

**Experimental.** Clients and Workers cache External Storage payloads in memory by default, so a payload already in the cache is not retrieved from its storage driver again. The SDK exposes a generic `PayloadCache` interface and an in-memory implementation, `InMemoryPayloadCache`, exported from `@temporalio/client` and `@temporalio/worker`. Pass a payload cache to clients and workers to configure it or share it between them, or pass `payloadCache: false` to disable caching:

```ts
import { Client, InMemoryPayloadCache } from '@temporalio/client';
import { Worker } from '@temporalio/worker';

const payloadCache = new InMemoryPayloadCache({
  maxTotalBytes: 128 * 1024 * 1024,
  maxEntries: 20_000,
});

const client = new Client({ payloadCache });
const worker = await Worker.create({ taskQueue, workflowsPath, payloadCache });

const uncachedClient = new Client({ payloadCache: false });
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
