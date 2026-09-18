# `@temporalio/test`

## Workflow test modules

Keep a test's workflow implementation in a dedicated module under `src/workflows/`.
For a test named `src/test-foo.ts`, put its workflows in `src/workflows/foo.ts` and use
`makeTestFunction({})`. The test helper infers that workflow entry point from AVA's test filename.

```ts
import { helpers, makeTestFunction } from './helpers-integration';
import { fooWorkflow } from './workflows/foo';

const test = makeTestFunction({});
```

This prevents test-only and third-party dependencies from being included in the Workflow bundle.
Specify `workflowsPath` only when the test intentionally uses a different entry point, such as a
directory bundle or a historical workflow module.
