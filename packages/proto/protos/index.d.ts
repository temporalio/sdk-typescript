/**
 * This package contains code generated from the Temporal `sdk-core` protobuf definitions using [protobufjs](https://www.npmjs.com/package/protobufjs), it is used by the Temporal worker and client packages.
 *
 * You will most likely never import this package directly.
 *
 * ### Core SDK API
 *
 * [Core SDK](https://github.com/temporalio/sdk-core) interfaces can be accessed in the `coresdk` namespace.
 *
 * ```ts
 * import { coresdk } from '@temporalio/proto';
 * const activityTask: coresdk.activity_task.IActivityTask = { ... };
 * ```
 *
 * The source protos are in the [sdk-core repo](https://github.com/temporalio/sdk-core/tree/ts-release/protos/local/temporal/sdk/core), for example [`ActivityTask` in `activity_task.proto`](https://github.com/temporalio/sdk-core/blob/85454935e39f789aaaa81f8a05773f8e2cdbcde2/protos/local/temporal/sdk/core/activity_task/activity_task.proto#L12).
 *
 * ### Temporal Service API
 *
 * Temporal API interfaces - used to communicate with the Temporal service - can be accessed in the `temporal` namespace.
 *
 * ```ts
 * import { temporal } from '@temporalio/proto';
 * const retryPolicy: temporal.api.common.v1.IRetryPolicy = { ... };
 * ```
 *
 * The source protos are in [sdk-core/protos/api_upstream/temporal/api/](https://github.com/temporalio/sdk-core/tree/ts-release/protos/api_upstream/temporal/api), for example [`RetryPolicy` in `temporal/api/common/v1/message.proto`](https://github.com/temporalio/sdk-core/blob/85454935e39f789aaaa81f8a05773f8e2cdbcde2/protos/api_upstream/temporal/api/common/v1/message.proto#L96).
 *
 * The gRPC service methods are documented in the proto comments and in the corresponding [`tctl` docs](https://docs.temporal.io/tctl/).
 * @module
 */

export * from './root';
