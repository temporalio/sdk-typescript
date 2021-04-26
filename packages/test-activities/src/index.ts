import fetch from 'node-fetch';
import { Context } from '@temporalio/activity';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function httpGet(url: string): Promise<string> {
  return `<html><body>hello from ${url}</body></html>`;
}

export async function throwAnError(message: string): Promise<void> {
  throw new Error(message);
}

export async function waitForCancellation(): Promise<void> {
  await Context.current().cancelled;
}

export async function cancellableFetch(url: string): Promise<Uint8Array> {
  try {
    const response = await fetch(`${url}/zeroes`, { signal: Context.current().cancellationSignal });
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
  } catch (err) {
    if (err.name === 'AbortError' && err.type === 'aborted') {
      const res = await fetch(`${url}/finish`);
      await res.text();
    }
    throw err;
  }
}

export async function progressiveSleep(): Promise<void> {
  await sleep(100);
  Context.current().heartbeat(1);
  await sleep(100);
  Context.current().heartbeat(2);
  await sleep(100);
  Context.current().heartbeat(3);
}
