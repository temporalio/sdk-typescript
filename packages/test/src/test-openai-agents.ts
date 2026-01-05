import { OpenAIProvider} from '@openai/agents';
import test from 'ava';
import { v4 as uuid4 } from 'uuid';
import { OpenAIAgentsPlugin } from '@temporalio/openai-agents';
import { Client } from '@temporalio/client';
import { Worker} from '@temporalio/worker';
import { haikuAgent } from './workflows/openai-agents';

const remoteTests = ['1', 't', 'true'].includes((process.env.OPENAI_AGENTS_REMOTE_TESTS ?? 'false').toLowerCase());

test('Haiku agent', async (t) => {
  if (remoteTests) {
    t.timeout(120 * 1000);
  }

  const plugin = new OpenAIAgentsPlugin({ modelProvider: new OpenAIProvider()});
  const options = {
    plugins: [plugin],
    workflowsPath: require.resolve('./workflows/openai-agents'),
    taskQueue: 'test-openai-agents',
  };
  const worker = await Worker.create(options);

  const client = new Client({
    plugins: [plugin],
  });
  await worker.runUntil(async () => {
    const result = await client.workflow.execute(haikuAgent, {
      args: ['Tell me about recursion in programming.'],
      workflowId: uuid4(),
      taskQueue: worker.options.taskQueue,
    });

    t.assert(result);
    if (!remoteTests) {
      t.is('Test Haiku', result);
    }
  });
});
