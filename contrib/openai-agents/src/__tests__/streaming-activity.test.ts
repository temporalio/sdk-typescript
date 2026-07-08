import test from 'ava';
import type { ModelProvider, StreamEvent } from '@openai/agents-core';
import type { Client } from '@temporalio/client';
import { MockActivityEnvironment } from '@temporalio/testing';
import { createModelActivity } from '../worker/activities';
import type {
  InvokeModelStreamActivityInput,
  SerializedModelRequest,
  SerializedStreamEvent,
} from '../common/serialized-model';
import { streamingTextEvents } from './stubs/openai-agents-fakes';

function minimalRequest(): SerializedModelRequest {
  return {
    input: 'hi',
    modelSettings: {},
    tools: [],
    toolsExplicitlyProvided: false,
    outputType: 'text',
    handoffs: [],
    tracing: false,
    overridePromptModel: false,
  };
}

function streamingProvider(events: StreamEvent[]): ModelProvider {
  return {
    getModel: () => ({
      async getResponse() {
        throw new Error('unused');
      },
      async *getStreamedResponse() {
        for (const event of events) yield event;
      },
    }),
  };
}

function recordingClient(published: unknown[][]): Client {
  return {
    withAbortSignal: <R>(_signal: AbortSignal, fn: () => Promise<R>) => fn(),
    workflow: {
      getHandle: (workflowId: string) => ({
        workflowId,
        async signal(_name: string, input: { items: Array<{ data: string }> }) {
          published.push(input.items);
        },
      }),
    },
  } as unknown as Client;
}

test('invokeModelStreamActivity publishes each event and returns the collected list', async (t) => {
  const events = streamingTextEvents('hello');
  const { invokeModelStreamActivity } = createModelActivity(streamingProvider(events));

  const published: unknown[][] = [];
  const env = new MockActivityEnvironment(undefined, { client: recordingClient(published) });

  const input: InvokeModelStreamActivityInput = {
    modelName: 'test-model',
    request: minimalRequest(),
    streamingTopic: 'events',
    streamingBatchInterval: '10ms',
  };

  const returned: SerializedStreamEvent[] = await env.run(invokeModelStreamActivity, input);

  t.is(returned.length, events.length, 'returns every event from the model stream');
  t.deepEqual(returned, events as unknown[]);

  const totalPublished = published.reduce((sum, batch) => sum + batch.length, 0);
  t.is(totalPublished, events.length, 'publishes every event live to the stream topic');
});
