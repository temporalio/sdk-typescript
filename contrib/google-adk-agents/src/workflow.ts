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
import './load-polyfills';

export { TemporalModel } from './model';
export type { TemporalModelOptions } from './model';

export { TemporalMCPToolset } from './mcp';
export type { TemporalMCPToolsetOptions, MCPToolsetFactory } from './mcp';

export { activityAsTool } from './tools';
export type { ActivityAsToolOptions } from './tools';
