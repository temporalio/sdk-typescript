import { readFileSync } from 'node:fs';
import { Worker } from '@temporalio/worker';
import { temporal } from '@temporalio/proto';

async function main(): Promise<void> {
  const { workflowsPath, history } = JSON.parse(readFileSync(0, 'utf8'));
  await Worker.runReplayHistory(
    { workflowExecutionMode: 'vmless', workflowsPath },
    temporal.api.history.v1.History.decode(Buffer.from(history, 'base64'))
  );
}

void main();
