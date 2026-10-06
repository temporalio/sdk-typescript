/**
 * A stdio MCP server exposing an `echo` tool, a `hang` tool that never answers, and one
 * `readme` resource, recording its session boundaries, tool and resource requests, and any
 * `notifications/cancelled` a client sends, to the file named by `MCP_STUB_LOG`. An unknown
 * tool gets the reply a real `McpServer` sends: a successful result carrying `isError: true`,
 * never a JSON-RPC error frame. An unknown resource gets the JSON-RPC error a real server
 * sends for `resources/read`. `MCP_STUB_HANG` names a request method (`resources/list`,
 * `resources/read`) the server records and then never answers, so a client can only leave
 * it by cancelling.
 */

import { appendFileSync } from 'node:fs';

interface JsonRpcMessage {
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes the input value.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  },
  {
    name: 'hang',
    description: 'Never replies, so a client can only leave by cancelling the request.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const RESOURCES = [
  { uri: 'file:///readme.md', name: 'readme', description: 'The stub README.', mimeType: 'text/markdown' },
];

function record(entry: string): void {
  const log = process.env.MCP_STUB_LOG;
  if (log) appendFileSync(log, `${entry}\n`);
}

function reply(id: number | string, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(id: number | string, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function handle(message: JsonRpcMessage): void {
  // How a client gives up on a request (`Protocol.request` in the MCP SDK sends it when
  // the request's signal aborts); a notification, so it has no id and needs no reply.
  if (message.method === 'notifications/cancelled') {
    record('notifications/cancelled');
    return;
  }
  if (message.id === undefined) return;
  if (message.method === process.env.MCP_STUB_HANG) {
    record(message.method);
    return;
  }
  switch (message.method) {
    case 'initialize':
      reply(message.id, {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'stub-mcp-server', version: '0.0.0' },
      });
      return;
    case 'tools/list':
      record('tools/list');
      reply(message.id, { tools: TOOLS });
      return;
    case 'tools/call': {
      record('tools/call');
      const params = (message.params ?? {}) as { name?: string; arguments?: { value?: unknown } };
      // The client's only way out is `notifications/cancelled`, which needs no reply.
      if (params.name === 'hang') return;
      if (params.name !== 'echo') {
        reply(message.id, {
          content: [{ type: 'text', text: `MCP error -32602: Tool ${params.name} not found` }],
          isError: true,
        });
        return;
      }
      reply(message.id, { content: [{ type: 'text', text: JSON.stringify({ echoed: params.arguments?.value }) }] });
      return;
    }
    case 'resources/list':
      record('resources/list');
      reply(message.id, { resources: RESOURCES });
      return;
    case 'resources/read': {
      record('resources/read');
      const params = (message.params ?? {}) as { uri?: string };
      const resource = RESOURCES.find((candidate) => candidate.uri === params.uri);
      if (!resource) {
        replyError(message.id, -32002, `Resource not found: ${params.uri}`);
        return;
      }
      reply(message.id, {
        contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: '# Stub\n\nHello from the stub resource.' }],
      });
      return;
    }
    default:
      replyError(message.id, -32601, `unsupported method ${message.method}`);
  }
}

record('open');

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffered += chunk;
  for (let newline = buffered.indexOf('\n'); newline !== -1; newline = buffered.indexOf('\n')) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (line) handle(JSON.parse(line) as JsonRpcMessage);
  }
});
process.stdin.on('end', () => {
  record('close');
  process.exit(0);
});
