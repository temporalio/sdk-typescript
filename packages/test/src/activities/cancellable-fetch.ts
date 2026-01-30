import { Context } from '@temporalio/activity';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function cancellableFetch(url: string): Promise<Uint8Array> {
  // Use native fetch - it handles AbortSignal correctly in both Node.js and Bun.
  // node-fetch has a bug in Bun where the abort reason is treated as an unhandled
  // rejection and the body stream doesn't properly abort.
  const response = await fetch(url, { signal: Context.current().cancellationSignal });
  const contentLengthHeader = response.headers.get('Content-Length');
  if (contentLengthHeader === null) {
    throw new Error('expected Content-Length header to be set');
  }
  const contentLength = parseInt(contentLengthHeader);
  let bytesRead = 0;
  const chunks: Uint8Array[] = [];

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('expected response body');
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    bytesRead += value.length;
    chunks.push(value);
    Context.current().heartbeat(bytesRead / contentLength);
    await sleep(500);
  }

  // Concatenate chunks
  const result = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
