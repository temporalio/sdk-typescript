import fetch from 'node-fetch';
import http from 'http';
import { Context } from '@temporalio/activity';

export async function httpGet(url: string): Promise<string> {
  return `<html><body>hello from ${url}</body></html>`;
}

export async function throwAnError(message: string): Promise<void> {
  throw new Error(message);
}

export async function waitForCancellation(): Promise<void> {
  await Context.current().cancelled;
}

export async function cancellableFetch(): Promise<Uint8Array> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, 'OK', { 'Content-Length': '5' });
    setTimeout(() => res.end(), 5000);
  });
  server.listen();
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) {
    throw new Error('Unexpected server address type');
  }
  const { port } = addr;

  const response = await fetch(`http://127.0.0.1:${port}`, { signal: Context.current().cancellationSignal });
  const contentLengthHeader = response.headers.get('Content-Length');
  if (contentLengthHeader === null) {
    throw new Error('expected Content-Length header to be set');
  }
  const contentLength = parseInt(contentLengthHeader);
  let bytesRead = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of response.body) {
    if (!(chunk instanceof Buffer)) {
      throw new TypeError('Expected Buffer');
    }
    bytesRead += chunk.length;
    chunks.push(chunk);
    Context.current().heartbeat(bytesRead / contentLength);
  }
  return Buffer.concat(chunks);
}

export async function progressiveSleep(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  Context.current().heartbeat(1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  Context.current().heartbeat(2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  Context.current().heartbeat(3);
}
