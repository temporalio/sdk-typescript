// Stub module that the StrandsPlugin's bundler config uses to replace
// worker-only transport modules and `node:*` schemes that
// `@strands-agents/sdk/mcp.js`/`mcp-config.js` import statically but that
// the workflow never reaches at runtime.
//
// `@strands-agents/sdk/mcp.js` does named imports like
// `import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'`,
// so a pure-empty module would fail webpack's ES-module named-export check
// at build time. Export every name MCP/Strands' static imports reach as a
// no-op class. Workflow code never instantiates these — the real transports
// run worker-side from the user's `mcpClients` factories.

class WorkflowSandboxStub {}

export {
  WorkflowSandboxStub as StreamableHTTPClientTransport,
  WorkflowSandboxStub as StdioClientTransport,
  WorkflowSandboxStub as SSEClientTransport,
};
export default WorkflowSandboxStub;
