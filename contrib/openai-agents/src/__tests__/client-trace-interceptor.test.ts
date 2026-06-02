import test from 'ava';
import type {
  WorkflowStartInput,
  WorkflowStartOutput,
  WorkflowSignalWithStartInput,
  WorkflowStartUpdateWithStartInput,
  WorkflowStartUpdateWithStartOutput,
} from '@temporalio/client';
import {
  OpenAIAgentsTraceClientInterceptor,
  type OpenAIAgentsTraceClientInterceptorOptions,
} from '../client/trace-interceptor';
import { AGENTS_CONFIG_HEADER_KEY, extractAgentsConfigHeader } from '../common/headers';
import { isReplaySafeTracerProvider, markReplaySafeTracerProvider, TemporalIdGenerator } from '../otel';
import { withSeededIds } from '../worker/seeded-ids';

function makeInterceptor(opts: OpenAIAgentsTraceClientInterceptorOptions = {}): OpenAIAgentsTraceClientInterceptor {
  return new OpenAIAgentsTraceClientInterceptor(opts);
}

test('interceptor.startWithDetails: injects __openai_agents_config header into the next call', async (t) => {
  const interceptor = makeInterceptor({
    addTemporalSpans: true,
    useOtelInstrumentation: false,
    modelParams: { startToCloseTimeout: '99s' },
  });

  let capturedHeaders: Record<string, any> | undefined;
  const next = async (input: WorkflowStartInput): Promise<WorkflowStartOutput> => {
    capturedHeaders = input.headers;
    return {
      workflowExecution: { workflowId: 'wf-id', runId: 'run-id' },
      executeWorkflowMetadata: { firstExecutionRunId: 'run-id', startTime: new Date() },
    } as unknown as WorkflowStartOutput;
  };

  await interceptor.startWithDetails(
    {
      headers: {},
      workflowType: 'TestWorkflow',
      options: { workflowId: 'wf-id', taskQueue: 'tq' } as any,
    } as WorkflowStartInput,
    next
  );

  t.truthy(capturedHeaders?.[AGENTS_CONFIG_HEADER_KEY], 'config header must be injected');
  const decoded = extractAgentsConfigHeader(capturedHeaders!);
  t.deepEqual(decoded, {
    addTemporalSpans: true,
    useOtelInstrumentation: false,
    modelParams: { startToCloseTimeout: '99s' },
  });
});

test('interceptor.signalWithStart: injects __openai_agents_config header', async (t) => {
  const interceptor = makeInterceptor({ modelParams: { startToCloseTimeout: '77s' } });

  let capturedHeaders: Record<string, any> | undefined;
  const next = async (input: WorkflowSignalWithStartInput): Promise<string> => {
    capturedHeaders = input.headers;
    return 'run-id';
  };

  await interceptor.signalWithStart(
    {
      headers: {},
      workflowType: 'TestWorkflow',
      signalName: 'sig',
      signalArgs: [],
      options: { workflowId: 'wf-id', taskQueue: 'tq' } as any,
    } as WorkflowSignalWithStartInput,
    next
  );

  t.truthy(capturedHeaders?.[AGENTS_CONFIG_HEADER_KEY]);
  const decoded = extractAgentsConfigHeader(capturedHeaders!);
  t.is(decoded?.modelParams?.startToCloseTimeout, '77s');
});

test('interceptor.startUpdateWithStart: injects __openai_agents_config on the workflow-start headers', async (t) => {
  const interceptor = makeInterceptor({ modelParams: { startToCloseTimeout: '55s' } });

  let capturedWorkflowStartHeaders: Record<string, any> | undefined;
  const next = async (input: WorkflowStartUpdateWithStartInput): Promise<WorkflowStartUpdateWithStartOutput> => {
    capturedWorkflowStartHeaders = input.workflowStartHeaders;
    return {
      workflowExecution: { workflowId: 'wf-id', runId: 'run-id' },
      updateRef: { workflowExecution: { workflowId: 'wf-id', runId: 'run-id' }, updateId: 'u' },
    } as unknown as WorkflowStartUpdateWithStartOutput;
  };

  await interceptor.startUpdateWithStart(
    {
      workflowStartHeaders: {},
      updateHeaders: {},
      workflowType: 'TestWorkflow',
      updateName: 'up',
      updateArgs: [],
      workflowStartOptions: { workflowId: 'wf-id', taskQueue: 'tq' } as any,
      updateOptions: {} as any,
    } as WorkflowStartUpdateWithStartInput,
    next
  );

  t.truthy(capturedWorkflowStartHeaders?.[AGENTS_CONFIG_HEADER_KEY]);
  const decoded = extractAgentsConfigHeader(capturedWorkflowStartHeaders!);
  t.is(decoded?.modelParams?.startToCloseTimeout, '55s');
});

test('interceptor: config header round-trips all three options (addTemporalSpans, useOtelInstrumentation, modelParams)', async (t) => {
  const modelParams = {
    startToCloseTimeout: '60s' as const,
    useLocalActivity: true,
    summary: 'Custom summary',
  };
  const interceptor = makeInterceptor({
    addTemporalSpans: true,
    useOtelInstrumentation: true,
    modelParams,
  });

  let capturedHeaders: Record<string, any> | undefined;
  const next = async (input: WorkflowStartInput): Promise<WorkflowStartOutput> => {
    capturedHeaders = input.headers;
    return {
      workflowExecution: { workflowId: 'wf-id', runId: 'run-id' },
    } as unknown as WorkflowStartOutput;
  };
  await interceptor.startWithDetails(
    {
      headers: {},
      workflowType: 'TestWorkflow',
      options: { workflowId: 'wf-id', taskQueue: 'tq' } as any,
    } as WorkflowStartInput,
    next
  );

  const decoded = extractAgentsConfigHeader(capturedHeaders!);
  t.deepEqual(decoded, {
    addTemporalSpans: true,
    useOtelInstrumentation: true,
    modelParams,
  });
});

test('TemporalIdGenerator: returns seeded ids inside withSeededIds, falls back outside', (t) => {
  const idGen = new TemporalIdGenerator();
  const traceSeed = 'aabbccddeeff00112233445566778899';
  const spanSeed = traceSeed.slice(0, 16);

  const ids = withSeededIds(traceSeed, spanSeed, () => ({
    trace: idGen.generateTraceId(),
    span: idGen.generateSpanId(),
  }));
  t.is(ids.trace, traceSeed);
  t.is(ids.span, spanSeed);

  const unseededTrace = idGen.generateTraceId();
  const unseededSpan = idGen.generateSpanId();
  t.is(unseededTrace.length, 32);
  t.is(unseededSpan.length, 16);
  t.not(unseededTrace, traceSeed);
  t.not(unseededSpan, spanSeed);
});

test('replay-safe tracer provider marker: marks custom providers without exposing the brand key', (t) => {
  const provider = {};

  t.false(isReplaySafeTracerProvider(provider));
  t.is(markReplaySafeTracerProvider(provider), provider);
  t.true(isReplaySafeTracerProvider(provider));
  t.deepEqual(Object.keys(provider), []);
});
