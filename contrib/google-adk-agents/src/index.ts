/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Worker-side API for the Google ADK Temporal plugin. The workflow-safe
 * surface (`TemporalModel`, `TemporalMCPToolset`, `activityAsTool`) lives in
 * the `@temporalio/google-adk-agents/workflow` entry point; test helpers in
 * `@temporalio/google-adk-agents/testing`.
 */

/**
 * @experimental The Google ADK plugin is an experimental feature; APIs may change without notice.
 */

export { GoogleAdkPlugin } from './plugin.js';
export type { GoogleAdkPluginOptions } from './plugin.js';
