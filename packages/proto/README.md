# `@temporalio/proto`

[![NPM](https://img.shields.io/npm/v/@temporalio/proto)](https://www.npmjs.com/package/@temporalio/proto)

Part of the [Temporal](https://temporal.io) [NodeJS SDK](https://www.npmjs.com/package/temporalio).

This package contains code generated from the Temporal `sdk-core` protobuf definitions using [protobufjs](https://www.npmjs.com/package/protobufjs), it is used by the Temporal worker and client packages.

### Core SDK API

[Core SDK](https://github.com/temporalio/sdk-core) interfaces can be accessed in the `coresdk` namespace in `@temporalio/proto`.

```ts
import { coresdk } from '@temporalio/proto';
const activityTask: coresdk.activity_task.IActivityTask = { ... };
```

### Temporal Service API

Temporal API interfaces - used to communicate with the Temporal service - can be accessed in the `temporal` namespace in `@temporalio/proto`.

```ts
import { temporal } from '@temporalio/proto';
const retryPolicy: temporal.api.common.v1.IRetryPolicy = { ... };
```
