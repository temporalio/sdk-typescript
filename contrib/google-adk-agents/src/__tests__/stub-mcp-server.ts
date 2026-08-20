/**
 * A stdio MCP server exposing one `echo` tool, recording its session boundaries and
 * tool requests to the file named by `MCP_STUB_LOG`. An unknown tool gets the reply a
 * real `McpServer` sends: a successful result carrying `isError: true`, never a
 * JSON-RPC error frame.
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
  if (message.id === undefined) return;
  switch (message.method) {
    case 'initialize':
      reply(message.id, {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
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
