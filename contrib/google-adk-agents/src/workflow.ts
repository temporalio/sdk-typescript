/**
 * Workflow-safe API for the Google ADK Temporal plugin — importable from
 * Workflow code running in the V8 sandbox.
 *
 * @experimental The Google ADK plugin is an experimental feature; APIs may change without notice.
 *
 * @module
 */

// Side-effect import: install Workflow-sandbox polyfills (gated internally on
// `inWorkflowContext()`) before any ADK code runs in the bundle.
// eslint-disable-next-line import/no-unassigned-import
import './load-polyfills';

export { TemporalModel } from './model';
export type { TemporalModelOptions } from './model';

export { markModelFailureHandled } from './absorbed-failure';

export { TemporalMCPToolset, loadMcpResourceTool } from './mcp';
export type {
  TemporalMCPToolsetOptions,
  MCPToolsetFactory,
  LoadMcpResourceToolOptions,
  MCPResourceContents,
} from './mcp';

export { activityAsTool } from './tools';
export type { ActivityAsToolOptions } from './tools';

export { activityNode } from './nodes';
export type { ActivityNodeOptions } from './nodes';

export { pendingHitlRequests, hitlInputResponse, hitlConfirmationResponse } from './hitl';
export type { HitlRequest, HitlConfirmation } from './hitl';

export type { RequireConfirmation } from './confirmation';

export {
  ADK_RUNTIME_FAILURE_TYPES,
  DYNAMIC_NODE_FAIL_FAILURE_TYPE,
  INTENT_MISMATCH_FAILURE_TYPE,
  INVOCATION_ABORTED_FAILURE_TYPE,
  MCP_ERROR_FAILURE_TYPE,
  MCP_RESOURCES_UNSUPPORTED_FAILURE_TYPE,
  MCP_TOOL_NOT_FOUND_FAILURE_TYPE,
  MODEL_ERROR_FAILURE_TYPE,
  NODE_REPORTED_FAILURE_TYPE,
  NODE_SCHEMA_VALIDATION_FAILURE_TYPE,
  NODE_TIMEOUT_FAILURE_TYPE,
  STATE_SCHEMA_FAILURE_TYPE,
  STREAMING_TOPIC_REQUIRED_FAILURE_TYPE,
  UNSUPPORTED_FAILURE_TYPE,
} from './error-types';
