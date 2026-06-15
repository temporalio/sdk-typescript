/**
 * @license
 * Copyright 2025 Temporal Technologies Inc.
 * SPDX-License-Identifier: MIT
 *
 * Web/Node global polyfills for the Temporal Workflow sandbox.
 *
 * `@google/adk` and `@google/genai` reference `Headers`, `structuredClone`,
 * and the WHATWG streams globals while building requests in the agent loop.
 * The Workflow sandbox does not expose all of them, so we install minimal
 * polyfills — but ONLY inside Workflow context (gated on `inWorkflowContext()`),
 * so a normal Node import (the worker / Activity side, tests, direct ADK use)
 * is left untouched. The plugin barrel imports this module for its side effect.
 */

import { inWorkflowContext } from '@temporalio/workflow';

if (inWorkflowContext()) {
  const globals = globalThis as Record<string, unknown>;

  if (typeof globals.Headers === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Headers } = require('headers-polyfill');
    globals.Headers = Headers;
  }

  if (typeof globals.structuredClone === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    globals.structuredClone = require('@ungap/structured-clone').default;
  }

  if (typeof globals.ReadableStream === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports,import/no-unassigned-import
    require('web-streams-polyfill/polyfill');
  }
}
