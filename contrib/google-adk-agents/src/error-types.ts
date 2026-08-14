/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * The `ApplicationFailure.type` values this plugin raises, re-exported from the
 * `./workflow` entry point so Workflow code can match `failure.type` without
 * hand-typing the strings.
 */

/** Error type when streaming is requested but `TemporalModelOptions.streamingTopic` is unset. */
export const STREAMING_TOPIC_REQUIRED_FAILURE_TYPE = 'GoogleAdkStreamingTopicRequired';

/** Error type when `BaseLlm.connect` (BIDI live streaming) is called inside a Workflow. */
export const UNSUPPORTED_FAILURE_TYPE = 'GoogleAdkUnsupported';

/** Error type when `TemporalMCPToolset.getTools()` runs outside a Workflow without `connectionParams`. */
export const MCP_TOOLSET_OUTSIDE_WORKFLOW_FAILURE_TYPE = 'GoogleAdkMCPToolsetOutsideWorkflow';

/** Error type when an `activityAsTool` tool runs outside a Workflow. */
export const ACTIVITY_TOOL_OUTSIDE_WORKFLOW_FAILURE_TYPE = 'GoogleAdkActivityToolOutsideWorkflow';

/** Error type when the `<name>-callTool` Activity finds no tool by the requested name. */
export const MCP_TOOL_NOT_FOUND_FAILURE_TYPE = 'GoogleAdkMCPToolNotFound';

/**
 * Error type for a failed model or MCP call. When the upstream reported an HTTP
 * status it is appended as `.<status>` — e.g. `GoogleAdkModelError.429`.
 */
export const MODEL_ERROR_FAILURE_TYPE = 'GoogleAdkModelError';
