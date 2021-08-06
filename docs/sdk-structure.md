# SDK Structure

The Node.js SDK is developed in a mono-repo consisting of several packages managed with [`lerna`](https://lerna.js.org/), the public packages are listed below.

- [`temporalio`](../packages/meta) - Meta package, bundles the common packages for ease of installation.
- [`@temporalio/worker`](../packages/worker) - Communicates with the Temporal service and runs workflows and activities
- [`@temporalio/workflow`](../packages/workflow) - Workflow runtime library
- [`@temporalio/activity`](../packages/activity) - Access to current activity context
- [`@temporalio/client`](../packages/client) - Communicate with the Temporal service for things like administration and scheduling workflows
- [`@temporalio/proto`](../packages/proto) - Compiled protobuf definitions
- [`@temporalio/create`](../packages/create-project) - NPM package initializer

[Repo visualization](https://octo-repo-visualization.vercel.app/?repo=temporalio%2Fsdk-node)