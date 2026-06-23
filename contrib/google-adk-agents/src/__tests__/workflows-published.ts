/**
 * A Workflow fixture that imports the plugin barrel BY PACKAGE NAME
 * (`@temporalio/google-adk-agents`) rather than via a relative source path.
 * When the Worker bundles this file, webpack resolves the by-name import to the
 * compiled `lib` (the published artifact), so a successful bundle + run proves
 * the lib bundles into a Workflow with no webpack error and executes.
 */

import { TemporalModel } from '@temporalio/google-adk-agents';
import type { LlmRequest } from '@google/adk';

/** One model call through the lib-resolved `TemporalModel`; returns its text. */
export async function publishedSingleModelCall(prompt: string): Promise<string> {
  const llm = new TemporalModel('fake-model');
  const request = {
    model: 'fake-model',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {},
    toolsDict: {},
    liveConnectConfig: {},
  } as LlmRequest;

  let text = '';
  for await (const response of llm.generateContentAsync(request)) {
    for (const part of response.content?.parts ?? []) {
      if (part.text) text += part.text;
    }
  }
  return text;
}
