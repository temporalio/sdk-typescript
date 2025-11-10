// Test workflow using AI model
// eslint-disable-next-line import/no-unassigned-import
import '@temporalio/ai-sdk/lib/load-polyfills';
import { generateObject, generateText, stepCountIs, tool } from 'ai';
import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import { z } from 'zod';
import { temporalProvider } from '@temporalio/ai-sdk';
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from "../activities/ai-sdk";

const { getWeather } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute"
})

export async function helloWorldAgent(prompt: string): Promise<string> {
  const result = await generateText({ 
    model: temporalProvider.languageModel("gpt-4o-mini"),
    prompt,
    system: "You only respond in haikus.",
  });
  return result.text;
}

export async function toolsWorkflow(question: string): Promise<string> {
  const result = await generateText({
    model: temporalProvider.languageModel("gpt-4o-mini"),
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
    stopWhen: stepCountIs(5),
  });
  return result.text;
}

export async function generateObjectWorkflow(): Promise<string> {
  const { object } = await generateObject({
    model: temporalProvider.languageModel("gpt-4o-mini"),
    schema: z.object({
      recipe: z.object({
        name: z.string(),
        ingredients: z.array(z.object({ name: z.string(), amount: z.string() })),
        steps: z.array(z.string()),
      }),
    }),
    prompt: 'Generate a lasagna recipe.',
  });
  return object.recipe.name;
}

export async function mcpToolsWorkflow(): Promise<string> {

  const mcpClient = await createMCPClient({
    transport: {
      type: 'http',
      url: 'https://your-server.com/mcp',
    },
  });

  const { object } = await generateObject({
    model: temporalProvider.languageModel("gpt-4o-mini"),
    schema: z.object({
      recipe: z.object({
        name: z.string(),
        ingredients: z.array(z.object({ name: z.string(), amount: z.string() })),
        steps: z.array(z.string()),
      }),
    }),
    prompt: 'Generate a lasagna recipe.',
  });
  return object.recipe.name;
}