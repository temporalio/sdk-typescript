import test from 'ava';
import {
  Agent,
  getGlobalTraceProvider,
  setTraceProcessors,
  withTrace,
  type ModelRequest,
  type Span as AgentSpan,
  type SpanData,
} from '@openai/agents-core';
import { ActivityBackedModel } from '../workflow/activity-backed-model';
import type { ModelSummaryProvider } from '../common/model-activity-options';
import { streamingTextEvents } from './stubs/openai-agents-fakes';

function minimalRequest(): ModelRequest {
  return {
    systemInstructions: 'sys',
    input: 'hi',
    modelSettings: {},
    tools: [],
    toolsExplicitlyProvided: false,
    outputType: 'text',
    handoffs: [],
    tracing: false,
  } as unknown as ModelRequest;
}

function fakeStreamActivities(returnEvents: unknown[]) {
  const plain: unknown[] = [];
  const withOptions: Array<{ opts: any; args: any[] }> = [];
  const fn = Object.assign(
    (input: unknown) => {
      plain.push(input);
      return Promise.resolve(returnEvents);
    },
    {
      executeWithOptions: (opts: any, args: any[]) => {
        withOptions.push({ opts, args });
        return Promise.resolve(returnEvents);
      },
    }
  );
  return { activities: { invokeModelStreamActivity: fn }, plain, withOptions };
}

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

test('getStreamedResponse: dynamic summary routes through executeWithOptions', async (t) => {
  const events = streamingTextEvents('hello');
  let provided: { agent: unknown; instructions: string | undefined; input: unknown } | undefined;
  const provider: ModelSummaryProvider = {
    provide: (agent, instructions, input) => {
      provided = { agent, instructions, input };
      return 'dynamic summary';
    },
  };
  const model = new ActivityBackedModel('gpt-4o', {
    startToCloseTimeout: '60s',
    streamingTopic: 'events',
    summary: provider,
  });
  const agent = new Agent({ name: 'A', model: 'gpt-4o' });
  model.setAgent(agent);
  const fake = fakeStreamActivities(events);
  (model as any).activities = fake.activities;

  const yielded = await withTrace('test', () => drain(model.getStreamedResponse(minimalRequest())));

  t.is(fake.withOptions.length, 1);
  t.is(fake.plain.length, 0);
  t.is(fake.withOptions[0]?.opts.summary, 'dynamic summary');
  t.is(provided?.instructions, 'sys');
  t.is(provided?.input, 'hi');
  t.is(provided?.agent, agent);
  t.is(yielded.length, events.length);
});

test('getStreamedResponse: no dynamic summary uses the plain proxy call', async (t) => {
  const events = streamingTextEvents('hi');
  const model = new ActivityBackedModel('gpt-4o', { startToCloseTimeout: '60s', streamingTopic: 'events' });
  const fake = fakeStreamActivities(events);
  (model as any).activities = fake.activities;

  const yielded = await withTrace('test', () => drain(model.getStreamedResponse(minimalRequest())));

  t.is(fake.plain.length, 1);
  t.is(fake.withOptions.length, 0);
  t.is(yielded.length, events.length);
});

test.serial('getStreamedResponse: opens a generation span carrying the model name', async (t) => {
  const events = streamingTextEvents('hi');
  const generationModels: Array<string | undefined> = [];
  const recorder = {
    onTraceStart: async () => {},
    onTraceEnd: async () => {},
    onSpanStart: async () => {},
    onSpanEnd: async (span: AgentSpan<SpanData>) => {
      const d = span.spanData as { type: string; model?: string };
      if (d.type === 'generation') generationModels.push(d.model);
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  setTraceProcessors([recorder as any]);
  getGlobalTraceProvider().setDisabled(false);

  try {
    const model = new ActivityBackedModel('gpt-4o-mini', { startToCloseTimeout: '60s', streamingTopic: 'events' });
    (model as any).activities = fakeStreamActivities(events).activities;
    await withTrace('test', async () => {
      await drain(model.getStreamedResponse(minimalRequest()));
    });
  } finally {
    getGlobalTraceProvider().setDisabled(true);
  }

  t.deepEqual(generationModels, ['gpt-4o-mini']);
});
