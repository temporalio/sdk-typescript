/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Workflow-safe API for the Google ADK Temporal plugin — importable from
 * Workflow code running in the V8 sandbox. The worker-side `GoogleAdkPlugin`
 * lives in the main `@temporalio/google-adk-agents` entry point; test helpers
 * in `@temporalio/google-adk-agents/testing`.
 */

// Side-effect import: install Workflow-sandbox polyfills (gated internally on
// `inWorkflowContext()`) before any ADK code runs in the bundle.
// eslint-disable-next-line import/no-unassigned-import
import './load-polyfills.js';

export { TemporalModel } from './model.js';
export type { TemporalModelOptions } from './model.js';

export { TemporalMCPToolset } from './mcp.js';
export type { TemporalMCPToolsetOptions, MCPToolsetFactory } from './mcp.js';

export { activityAsTool } from './tools.js';
export type { ActivityAsToolOptions } from './tools.js';
