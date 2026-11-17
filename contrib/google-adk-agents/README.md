# Google ADK compatibility package

This is the final planned release of `@temporalio/google-adk-agents`.

`@temporalio/google-adk-agents` forwards its root, `/workflow` and `/testing`
entrypoints to version 1.x of
[`@temporalio/google-adk`](https://github.com/temporalio/ai-integrations/tree/main/typescript/google-adk).
Existing imports continue to work, and both names expose the same classes,
functions and types. The implementation and its provider requirements are owned
by the standalone package.

This wrapper requires Node.js 22.17.0 or later and the provider versions required
by the standalone package. New applications should install `@temporalio/google-adk`
directly. Existing applications can migrate by replacing `@temporalio/google-adk-agents`
with `@temporalio/google-adk` in their dependencies and imports.

The wrapper preserves import paths. It does not restore workflow-history replay
compatibility across the ADK 1-to-2 upgrade or the standalone plugin's renamed
random stream. Drain affected in-flight Workflows or route the old and new Workers
to separate task queues when making that cutover.

See the [1.0.0 upgrade notes](https://github.com/temporalio/ai-integrations/releases/tag/typescript/google-adk/v1.0.0#how-to-upgrade)
when upgrading from the 0.1.x integration.

```ts
import { GoogleAdkPlugin } from '@temporalio/google-adk-agents';
// Inside a Workflow:
import { TemporalModel } from '@temporalio/google-adk-agents/workflow';
// Test helpers:
import { fakeModelProvider } from '@temporalio/google-adk-agents/testing';
```
