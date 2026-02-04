import { Context } from '@temporalio/activity';

export async function cancellableFetch(url: string): Promise<Uint8Array> {
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

  let { done, value } = await reader.read();
  while (!done) {
    bytesRead += value.length;
    chunks.push(value);
    Context.current().heartbeat(bytesRead / contentLength);
    ({ done, value } = await reader.read());
  }

  return Buffer.concat(chunks);
}
