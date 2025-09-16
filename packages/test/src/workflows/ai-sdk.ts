// Test workflow using AI model
// eslint-disable-next-line import/no-unassigned-import
import "./load-webstream-polyfill"
import { generateText } from 'ai';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { TemporalProvider } from '@temporalio/ai-sdk';

globalThis.AI_SDK_DEFAULT_PROVIDER = new TemporalProvider(createOpenAI({apiKey: "fake"}))

export async function aiTestWorkflow(prompt: string): Promise<string> {
  const result = await generateText({ model: "gpt-4o-mini", prompt });
  return result.text;
}
