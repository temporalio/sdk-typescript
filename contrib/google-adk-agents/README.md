# Google ADK compatibility package

`@temporalio/google-adk-agents` forwards its root, `/workflow` and `/testing`
entrypoints to
[`@temporalio/google-adk`](https://github.com/temporalio/ai-integrations/tree/main/typescript/google-adk).
Existing imports continue to work, and both names expose the same classes,
functions and types. The implementation and its provider requirements are owned
by the standalone package.

This wrapper requires Node.js 22.12.0 or later and the provider versions required
by the standalone package, including Google ADK 2.0. New applications should install
`@temporalio/google-adk` directly. Existing applications can migrate by replacing
`@temporalio/google-adk-agents` with `@temporalio/google-adk` in their dependencies
and imports.

The wrapper preserves import paths. It does not restore workflow-history replay
compatibility across the ADK 1-to-2 upgrade or the standalone plugin's renamed
random stream. Drain affected in-flight Workflows or route the old and new Workers
to separate task queues when making that cutover.

```ts
import { GoogleAdkPlugin } from '@temporalio/google-adk-agents';
// Inside a Workflow:
import { TemporalModel } from '@temporalio/google-adk-agents/workflow';
// Test helpers:
import { fakeModelProvider } from '@temporalio/google-adk-agents/testing';
```
