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

export async function cancellableFetch(): Promise<void> {
  const server = http.createServer((_req, res) => {
    setTimeout(() => res.end(), 5000);
  });
  server.listen();
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) {
    throw new Error('Unexpected server address type');
  }
  const { port } = addr;

  await fetch(`http://127.0.0.1:${port}`, { signal: Context.current().cancellationSignal });
}

export async function progressiveSleep(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  Context.current().heartbeat(1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  Context.current().heartbeat(2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  Context.current().heartbeat(3);
}
