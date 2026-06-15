/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Public API for the Google ADK Temporal plugin. Test helpers live in the
 * separate `@temporalio/google-adk-agents/testing` entry point.
 */

// Side-effect import: install Workflow-sandbox polyfills (gated internally on
// `inWorkflowContext()`) before any ADK code runs in the bundle.
// eslint-disable-next-line import/no-unassigned-import
import './load-polyfills.js';

export { GoogleAdkPlugin } from './plugin.js';
export type { GoogleAdkPluginOptions } from './plugin.js';

export { TemporalLlm } from './model.js';
export type {
  TemporalLlmOptions,
  TemporalActivityOptions,
  ModelActivities,
  InvokeModelArgs,
  InvokeModelStreamingArgs,
  WireLlmRequest,
} from './model.js';

export { TemporalMcpToolset, TemporalMcpTool } from './mcp.js';
export type {
  TemporalMcpToolsetOptions,
  McpToolsetFactory,
  McpCallToolArgs,
  McpActivities,
} from './mcp.js';

export { activityAsTool, ActivityTool } from './tools.js';
export type { ActivityAsToolOptions } from './tools.js';
