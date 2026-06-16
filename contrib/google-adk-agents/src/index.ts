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

export { TemporalModel } from './model.js';
export type { TemporalModelOptions } from './model.js';

export { TemporalMcpToolSet } from './mcp.js';
export type { TemporalMcpToolSetOptions, McpToolsetFactory } from './mcp.js';

export { activityAsTool } from './tools.js';
export type { ActivityAsToolOptions } from './tools.js';
