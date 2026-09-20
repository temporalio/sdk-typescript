/**
 * The `ApplicationFailure.type` values this plugin raises.
 */

/**
 * Error type when streaming is requested but `TemporalModelOptions.streamingTopic`
 * is unset. Non-retryable, and thrown in the Workflow, so code calling
 * `TemporalModel` directly catches it unwrapped.
 */
export const STREAMING_TOPIC_REQUIRED_FAILURE_TYPE = 'GoogleAdkStreamingTopicRequired';

/**
 * Error type when `BaseLlm.connect` (BIDI live streaming) is called inside a
 * Workflow. Non-retryable, and thrown in the Workflow to whoever called `connect`,
 * so it arrives unwrapped.
 */
export const UNSUPPORTED_FAILURE_TYPE = 'GoogleAdkUnsupported';

/** @internal */
export const MCP_TOOLSET_OUTSIDE_WORKFLOW_FAILURE_TYPE = 'GoogleAdkMCPToolsetOutsideWorkflow';

/** @internal */
export const ACTIVITY_TOOL_OUTSIDE_WORKFLOW_FAILURE_TYPE = 'GoogleAdkActivityToolOutsideWorkflow';

/**
 * Error type when the `<name>-callTool` Activity finds no tool by the requested name
 * in the `BaseToolset` its factory returned. Non-retryable, and raised inside that
 * Activity, so it arrives wrapped in an `ActivityFailure`: match it through the
 * `.cause` chain, never against the caught error's own `.type`. It reaches code that
 * calls the tool's `runAsync` itself.
 *
 * A factory returning `MCPConnectionParams` never raises it: the plugin calls the tool
 * without resolving the name first, so the caller gets whatever the server answers.
 */
export const MCP_TOOL_NOT_FOUND_FAILURE_TYPE = 'GoogleAdkMCPToolNotFound';

/**
 * Error type for a failed model call. Raised inside an Activity, so it arrives
 * wrapped in an `ActivityFailure`: match it through the `.cause` chain. A request
 * carrying an `adk_agent_name` label, as an ADK agent run's requests do, has its
 * failure recorded: it fails the Workflow — or rejects the Update whose handler ran
 * the turn — unless an `onModelErrorCallback` recovers and calls
 * `markModelFailureHandled(error)`. A hand-built request ordinarily carries none, and
 * then only throws at the call site.
 *
 * A failure that carries an HTTP status has it appended as `.<status>`, for example
 * `GoogleAdkModelError.429`, so match with `startsWith`, not `===`; such a failure is
 * retryable for 408, 409, 429 and 5xx and non-retryable otherwise. One carrying no
 * status is the bare type and retryable. An `x-should-retry` response header overrides
 * either verdict.
 */
export const MODEL_ERROR_FAILURE_TYPE = 'GoogleAdkModelError';

/**
 * Error type for a failed MCP `listTools` or `callTool` call. Raised inside an
 * Activity, so wherever you catch it, it arrives wrapped in an `ActivityFailure`:
 * match it through the `.cause` chain, never against the caught error's own `.type`.
 *
 * An HTTP status, when present, is appended and classified exactly as for
 * {@link MODEL_ERROR_FAILURE_TYPE} — but an MCP failure rarely carries one, so a
 * rejected token or an unreachable server classifies as retryable rather than
 * failing fast, and the plugin sets no retry policy: the call retries indefinitely
 * until the caller bounds it with
 * `TemporalMCPToolsetOptions.activity.retry.maximumAttempts`.
 */
export const MCP_ERROR_FAILURE_TYPE = 'GoogleAdkMCPError';

/**
 * Error type for an answer the HITL wire-format helpers refuse: a request of the
 * wrong `kind`, or a string ADK would silently retype on the way into the node.
 * Non-retryable, and raised where the helper is called.
 *
 * It is an `ApplicationFailure` rather than a `TypeError` so that building the
 * response inside an Update handler rejects the Update: the SDK rejects an update
 * only for a `TemporalFailure` (`packages/workflow/src/internals.ts`), and any
 * other error fails the Workflow Task instead, which then retries forever against
 * an answer the caller can no longer take back.
 */
export const HITL_RESPONSE_FAILURE_TYPE = 'GoogleAdkHitlResponseError';

/** @internal */
export const ACTIVITY_NODE_OUTSIDE_WORKFLOW_FAILURE_TYPE = 'GoogleAdkActivityNodeOutsideWorkflow';

/** @internal */
export const ACTIVITY_NODE_NAME_FAILURE_TYPE = 'GoogleAdkActivityNodeName';

/**
 * Error type for an ADK workflow-runtime node that exceeded its `timeout`.
 * ADK raises a plain `NodeTimeoutError`; the plugin converts it to a
 * non-retryable `ApplicationFailure` of this type as it leaves the Workflow
 * (or the Signal/Update handler) that ran the graph, so the execution fails
 * instead of retrying the Workflow Task forever. The original error is the
 * `cause`. The same conversion, under the types below, applies to every ADK
 * runtime error listed in {@link ADK_RUNTIME_FAILURE_TYPES}.
 */
export const NODE_TIMEOUT_FAILURE_TYPE = 'GoogleAdkNodeTimeoutError';

/**
 * Error type for a graph node that finished without output because the agent
 * it ran absorbed an error (ADK's `NodeReportedError`). When the absorbed
 * error was a `TemporalModel` call, the plugin raises that call's
 * `ActivityFailure` instead, so the model failure's HTTP status and cause
 * chain survive.
 */
export const NODE_REPORTED_FAILURE_TYPE = 'GoogleAdkNodeReportedError';

/** Error type for a node input/output/state that failed its ADK schema (`NodeSchemaValidationError`). */
export const NODE_SCHEMA_VALIDATION_FAILURE_TYPE = 'GoogleAdkNodeSchemaValidationError';

/**
 * Error type for a human-in-the-loop approval ADK refused to bind to its gate
 * (`IntentMismatchError`) — for example an approval naming a tool that does not
 * require confirmation, or arguments that no longer match the pinned call.
 */
export const INTENT_MISMATCH_FAILURE_TYPE = 'GoogleAdkIntentMismatchError';

/** Error type for a session-state write that failed its ADK `stateSchema` (`StateSchemaError`). */
export const STATE_SCHEMA_FAILURE_TYPE = 'GoogleAdkStateSchemaError';

/** Error type for an ADK invocation aborted through its `abortSignal` (`InvocationAbortedError`). */
export const INVOCATION_ABORTED_FAILURE_TYPE = 'GoogleAdkInvocationAbortedError';

/**
 * Error type for a dynamic node (`ctx.runNode`) whose child failed
 * (`DynamicNodeFailError`). ADK wraps the child's error in it; when that error
 * was a Temporal failure — a failed or cancelled Activity — the plugin raises
 * the original instead, so a cancelled execution still ends CANCELLED and the
 * cause chain matches a static node's.
 */
export const DYNAMIC_NODE_FAIL_FAILURE_TYPE = 'GoogleAdkDynamicNodeFailError';

/**
 * The ADK runtime errors the plugin converts into non-retryable
 * `ApplicationFailure`s, keyed by the error's `name` (ADK's own type guards
 * match by name too; not every class is exported). Any other error that
 * escapes a Workflow is left alone and follows the SDK's convention for
 * unexpected errors: it fails the Workflow *Task*, which retries. Use
 * `WorkerOptions.workflowFailureErrorTypes` to fail the execution on more.
 */
export const ADK_RUNTIME_FAILURE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  NodeTimeoutError: NODE_TIMEOUT_FAILURE_TYPE,
  NodeReportedError: NODE_REPORTED_FAILURE_TYPE,
  NodeSchemaValidationError: NODE_SCHEMA_VALIDATION_FAILURE_TYPE,
  IntentMismatchError: INTENT_MISMATCH_FAILURE_TYPE,
  StateSchemaError: STATE_SCHEMA_FAILURE_TYPE,
  InvocationAbortedError: INVOCATION_ABORTED_FAILURE_TYPE,
  DynamicNodeFailError: DYNAMIC_NODE_FAIL_FAILURE_TYPE,
});
