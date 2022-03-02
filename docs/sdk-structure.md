# SDK Structure

The TypeScript SDK is developed in a monorepo consisting of several packages managed with [`lerna`](https://lerna.js.org/). The public packages are:

- [`temporalio`](../packages/meta) - Meta package, bundles the common packages for ease of installation.
- [`@temporalio/worker`](../packages/worker) - Communicates with the Temporal service and runs workflows and activities
- [`@temporalio/workflow`](../packages/workflow) - Workflow runtime library
- [`@temporalio/activity`](../packages/activity) - Access to current activity context
- [`@temporalio/client`](../packages/client) - Communicate with the Temporal service for things like administration and scheduling workflows
- [`@temporalio/proto`](../packages/proto) - Compiled protobuf definitions
- [`@temporalio/workflow-common`](../packages/workflow-common) - Code shared between `@temporalio/workflow` and other packages
- [`@temporalio/common`](../packages/common) - All shared code (re-exports everything in `@temporalio/workflow-common`, and also has code shared between packages other than `@temporalio/workflow`)
- [`@temporalio/create`](../packages/create-project) - NPM package initializer

[Repo visualization](https://octo-repo-visualization.vercel.app/?repo=temporalio%2Fsdk-typescript)
