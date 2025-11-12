// Test workflow using AI model
// eslint-disable-next-line import/no-unassigned-import
import '@temporalio/ai-sdk/lib/load-polyfills';
import { generateObject, generateText, stepCountIs, tool, wrapLanguageModel } from 'ai';
import { z } from 'zod';
import { temporalProvider } from '@temporalio/ai-sdk';
import { inWorkflowContext, proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from "../activities/ai-sdk";
import { LanguageModelV2Middleware } from '@ai-sdk/provider';
import { ProxyTracerProvider, trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { MultiSpanProcessor } from '@opentelemetry/sdk-trace-base/build/esnext/MultiSpanProcessor';
import * as tracing from '@opentelemetry/sdk-trace-base';
import { SpanExporter } from '@temporalio/interceptors-opentelemetry/lib/workflow/span-exporter';

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

export async function middlewareWorkflow(prompt: string): Promise<string> {
  const cache = new Map<string, any>();
  const middleware: LanguageModelV2Middleware = {
    wrapGenerate: async ({ doGenerate, params }) => {
      const cacheKey = JSON.stringify(params);
      if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
      }

      const result = await doGenerate();

      cache.set(cacheKey, result);

      return result;
    },
  }

  const model = wrapLanguageModel({
    model: temporalProvider.languageModel("gpt-4o-mini"),
    middleware
  });

  const result = await generateText({
    model,
    prompt,
    system: "You only respond in haikus.",
  });
  return result.text;
}

export async function telemetryWorkflow(prompt: string): Promise<string> {
  const result = await generateText({
    model: temporalProvider.languageModel("gpt-4o-mini"),
    prompt,
    system: "You only respond in haikus.",
    experimental_telemetry: {
      isEnabled: true
    }
  });
  return result.text;
}