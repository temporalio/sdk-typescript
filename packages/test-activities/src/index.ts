import fetch from 'node-fetch';
import { Context } from '@temporalio/activity';
import { Connection } from '@temporalio/client';

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

async function signalSchedulingWorkflow(signalName: string) {
  const { info } = Context.current();
  const connection = new Connection(undefined, { namespace: info.workflowNamespace });
  await connection.service.signalWorkflowExecution({
    namespace: info.workflowNamespace,
    workflowExecution: Context.current().info.workflowExecution,
    signalName,
  });
}

export async function cancellableFetch(url: string, signalWorkflowOnCheckpoint = false): Promise<Uint8Array> {
  if (signalWorkflowOnCheckpoint) {
    await signalSchedulingWorkflow('activityStarted');
  }
  try {
    const response = await fetch(url, { signal: Context.current().cancellationSignal });
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
    if (signalWorkflowOnCheckpoint && err.name === 'AbortError' && err.type === 'aborted') {
      await signalSchedulingWorkflow('activityCancelled');
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
