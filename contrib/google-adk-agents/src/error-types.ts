/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
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
