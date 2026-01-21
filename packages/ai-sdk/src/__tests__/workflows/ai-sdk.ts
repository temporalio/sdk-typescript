// Test workflow using AI model
// eslint-disable-next-line import/no-unassigned-import
import '../../load-polyfills';
import { embedMany, generateText, Output, stepCountIs, tool, wrapLanguageModel } from 'ai';
import { z } from 'zod';
import type { LanguageModelV3Middleware } from '@ai-sdk/provider';
import { proxyActivities } from '@temporalio/workflow';
import { TemporalMCPClient, temporalProvider } from '../..';
import type * as activities from '../activities/ai-sdk';

const { getWeather } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

export async function helloWorldAgent(prompt: string): Promise<string> {
  const result = await generateText({
    model: temporalProvider.languageModel('gpt-4o-mini'),
    prompt,
    system: 'You only respond in haikus.',
  });
  return result.text;
}

export async function toolsWorkflow(question: string): Promise<string> {
  const result = await generateText({
    model: temporalProvider.languageModel('gpt-4o-mini'),
    prompt: question,
    system: 'You are a helpful agent.',
    tools: {
      getWeather: tool({
        description: 'Get the weather for a given city',
        inputSchema: z.object({
          location: z.string().describe('The location to get the weather for'),
        }),
        execute: async (input, _options) => getWeather(input),
      }),
    },
    stopWhen: stepCountIs(5),
  });
  return result.text;
}

export async function generateObjectWorkflow(): Promise<string> {
  const { output } = await generateText({
    model: temporalProvider.languageModel('gpt-4o-mini'),
    output: Output.object({
      schema: z.object({
        recipe: z.object({
          name: z.string(),
          ingredients: z.array(z.object({ name: z.string(), amount: z.string() })),
          steps: z.array(z.string()),
        }),
      }),
    }),
    prompt: 'Generate a lasagna recipe.',
  });
  return output.recipe.name;
}

export async function middlewareWorkflow(prompt: string): Promise<string> {
  const cache = new Map<string, any>();
  const middleware: LanguageModelV3Middleware = {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate, params }) => {
      const cacheKey = JSON.stringify(params);
      if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
      }

      const result = await doGenerate();

      cache.set(cacheKey, result);

      return result;
    },
  };

  const model = wrapLanguageModel({
    model: temporalProvider.languageModel('gpt-4o-mini'),
    middleware,
  });

  const result = await generateText({
    model,
    prompt,
    system: 'You only respond in haikus.',
  });
  return result.text;
}

export async function telemetryWorkflow(prompt: string): Promise<string> {
  const result = await generateText({
    model: temporalProvider.languageModel('gpt-4o-mini'),
    prompt,
    system: 'You only respond in haikus.',
    experimental_telemetry: {
      isEnabled: true,
    },
  });
  return result.text;
}

export async function mcpWorkflow(prompt: string): Promise<string> {
  const mcpClient = new TemporalMCPClient({ name: 'testServer' });
  const tools = await mcpClient.tools();
  const result = await generateText({
    model: temporalProvider.languageModel('gpt-4o-mini'),
    prompt,
    tools,
    system: 'What files do you have?',
    stopWhen: stepCountIs(5),
  });
  return result.text;
}

/**
 * Test workflow that returns MCP tool schema structure for assertion.
 * Used to verify inputSchema survives activity serialization correctly.
 */
export async function mcpSchemaTestWorkflow(): Promise<{
  toolName: string;
  schemaType: string | undefined;
  hasProperties: boolean;
  propertyDescription: string | undefined;
}> {
  const mcpClient = new TemporalMCPClient({ name: 'testServer' });
  const tools = await mcpClient.tools();

  const [toolName, tool] = Object.entries(tools)[0];

  const schema = (tool as any).inputSchema.jsonSchema;

  return {
    toolName,
    schemaType: schema.type,
    hasProperties: schema.properties !== undefined,
    propertyDescription: schema.properties?.testParam?.description,
  };
}

/**
 * Workflow that demonstrates embedding model support.
 * Uses the temporalProvider to generate embeddings for multiple text values.
 */
export async function embeddingWorkflow(
  values: string[]
): Promise<{ count: number; dimensions: number; totalTokens?: number }> {
  const result = await embedMany({
    model: temporalProvider.embeddingModel('text-embedding-3-small'),
    values,
  });

  return {
    count: result.embeddings.length,
    dimensions: result.embeddings[0]?.length ?? 0,
    totalTokens: result.usage?.tokens,
  };
}
