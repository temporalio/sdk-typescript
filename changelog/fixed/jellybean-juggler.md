Corrected the Schedule `catchupWindow` documentation to state that omitted values use the Temporal Server's configured default.
`@temporalio/strands-agents` tools built on Activities, `activityAsTool`, and MCP tools now give the model the Activity's own error message when a tool call fails, instead of "Activity task failed", and attach that error to the tool result for hooks.
`JsonPayloadConverter` no longer produces a payload with undefined data for values with no JSON representation, such as functions, symbols, and objects whose `toJSON` returns `undefined`. The default payload converter now throws a `ValueError` for these values, including symbols, which previously caused a `TypeError` while building the error message.
`@temporalio/ai-sdk` now preserves text provider metadata when replaying streamed model responses inside Workflows.
The Workflow sandbox now exposes `atob` and `btoa`, allowing integrations such as `@temporalio/ai-sdk` to process image and file tool results containing base64 data.
`@temporalio/create` now supports comments and trailing commas in `tsconfig.json` files when creating projects.
`WorkflowExecutionAlreadyStartedError` now exposes the `runId` of the already-running Workflow Execution when the server provides it in the error details (#1838).
Workflow code that blocks the sandbox past its time limit now fails with the `[TMPRL1101]` deadlock diagnostic (#2426).
