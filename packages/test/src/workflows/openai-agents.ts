import { Agent } from '@openai/agents';
// eslint-disable-next-line import/no-unassigned-import
import '@temporalio/openai-agents/lib/load-polyfills';
import { TemporalRunner } from '@temporalio/openai-agents';

export async function haikuAgent(prompt: string): Promise<string> {
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You always respond in Haikus.',
  });

  const result = await new TemporalRunner().run(agent, prompt);
  return result.finalOutput!;
}
