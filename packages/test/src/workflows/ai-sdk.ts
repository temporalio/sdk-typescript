// Test workflow using AI model
// eslint-disable-next-line import/no-unassigned-import
import '@temporalio/ai-sdk/lib/load-polyfills';
import { generateText, stepCountIs, tool } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { TemporalProvider } from '@temporalio/ai-sdk';
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from "../activities/ai-sdk";

const { getWeather } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute"
})

globalThis.AI_SDK_DEFAULT_PROVIDER = new TemporalProvider(createOpenAI({apiKey: "fake"}));

export async function helloWorldAgent(prompt: string): Promise<string> {
  const result = await generateText({ 
    model: "gpt-4o-mini", 
    prompt,
    system: "You only respond in haikus."
  });
  return result.text;
}

export async function toolsWorkflow(question: string): Promise<string> {
  const result = await generateText({
    model: 'gpt-4o-mini',
    prompt: question,
    system: 'You are a helpful agent.',
    tools: {
      getWeather: tool({
        description: 'Get the weather for a given city',
        inputSchema: z.object({
          location: z.string().describe('The location to get the weather for'),
        }),
        execute: getWeather,
      }),
    },
    stopWhen: stepCountIs(5)
  });
  console.log(result.finishReason)
  return result.text;
}
