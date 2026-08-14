/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * A user `interceptors.workflowModules` entry that imports `@google/adk`.
 * Interceptor modules all evaluate before any interceptor factory runs, so
 * this makes ADK's `telemetry/tracing.js` cache its tracer at module load —
 * before `OpenTelemetryPlugin` registers the sandbox tracer provider. The
 * telemetry test uses it to pin that ADK spans still export in this ordering,
 * which requires the bundle to hold a single `@opentelemetry/api` copy.
 */

import { LlmAgent } from '@google/adk';

/** Referenced so the `@google/adk` barrel import is not elided. */
export const adkEvaluated = typeof LlmAgent === 'function';
