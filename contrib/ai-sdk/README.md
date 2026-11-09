# Vercel AI SDK compatibility package

No additional versions of `@temporalio/ai-sdk` are expected to be published after 1.25.0.

`@temporalio/ai-sdk` forwards its root and `/workflow` entrypoints to
[`@temporalio/vercel-ai-sdk`](https://github.com/temporalio/ai-integrations/tree/main/typescript/vercel-ai-sdk).
Existing imports continue to work, and both names expose the same classes,
functions and types. The implementation and its provider requirements are owned
by the standalone package.

This wrapper requires Node.js 22.12.0 or later. New applications should install
`@temporalio/vercel-ai-sdk` directly. Existing applications can migrate by replacing
`@temporalio/ai-sdk` with `@temporalio/vercel-ai-sdk` in their dependencies and imports.

```ts
import { AiSdkPlugin } from '@temporalio/ai-sdk';
// Inside a Workflow:
import { temporalProvider } from '@temporalio/ai-sdk/workflow';
```
