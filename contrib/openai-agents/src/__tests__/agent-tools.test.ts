import test from 'ava';
import { Agent, Runner, type FunctionTool, type RunContext, type RunResult } from '@openai/agents-core';
import { SandboxAgent } from '@openai/agents-core/sandbox';
import { ApplicationFailure } from '@temporalio/common';
import { agentAsTool, extractToolOutput } from '../workflow/agent-tools';
import { temporalSandboxClient } from '../workflow/sandbox-client';
import { TemporalOpenAIRunner } from '../workflow/runner';
import { ToolSerializationError } from '../workflow/tools';

const specialist = new Agent({
  name: 'Specialist',
  instructions: 'You are a specialist.',
  model: 'gpt-4o-mini',
});

test('agentAsTool: returns FunctionTool with expected static fields', (t) => {
  const tool = agentAsTool(specialist, {
    toolName: 'ask_specialist',
    toolDescription: 'Ask the specialist',
  }) as FunctionTool;

  t.is(tool.type, 'function');
  t.is(tool.name, 'ask_specialist');
  t.is(tool.description, 'Ask the specialist');
  t.deepEqual(tool.parameters, {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input'],
    additionalProperties: false,
  });
});

test('agentAsTool: strict is always true', (t) => {
  const tool = agentAsTool(specialist, { toolName: 'ask_specialist' }) as FunctionTool;
  t.is(tool.strict, true);
});

test('agentAsTool: needsApproval is false, isEnabled is true', async (t) => {
  const tool = agentAsTool(specialist, { toolName: 'ask_specialist' }) as FunctionTool;
  const fakeCtx = {} as RunContext<any>;
  const fakeAgent = {} as any;
  const fakeCall = {} as any;
  t.is(await tool.needsApproval(fakeCtx, fakeCall, ''), false);
  t.is(await tool.isEnabled(fakeCtx, fakeAgent), true);
});

test('agentAsTool: invoke with malformed JSON throws ToolSerializationError', async (t) => {
  const tool = agentAsTool(specialist, { toolName: 'ask_specialist' }) as FunctionTool;
  const err = await t.throwsAsync(() => tool.invoke({} as RunContext<any>, 'not-json'));
  t.true(err instanceof ToolSerializationError);
  t.regex((err as Error).message, /ask_specialist/);
});

test('agentAsTool: invoke outside workflow context fails after JSON parse succeeds', async (t) => {
  const tool = agentAsTool(specialist, { toolName: 'ask_specialist' }) as FunctionTool;
  const err = await t.throwsAsync(() => tool.invoke({} as RunContext<any>, '{"input":"hi"}'));
  t.false(err instanceof ToolSerializationError, 'should fail after JSON parse, not during it');
  t.regex((err as Error).message, /Workflow Execution|workflowInfo/i);
});

test.serial('agentAsTool: nested SandboxAgent inherits parent sandbox config', async (t) => {
  const sandboxAgent = new SandboxAgent({ name: 'Sandbox specialist', model: 'gpt-4o-mini' });
  const tool = agentAsTool(sandboxAgent, { toolName: 'ask_sandbox' });
  const parent = new Agent({ name: 'Parent', model: 'gpt-4o-mini', tools: [tool] });
  const sandboxes = [{ client: temporalSandboxClient('first') }, { client: temporalSandboxClient('second') }];
  const receivedSandboxes: unknown[] = [];
  const originalTemporalRun = TemporalOpenAIRunner.prototype.run;
  TemporalOpenAIRunner.prototype.run = async function (
    this: TemporalOpenAIRunner,
    agent: any,
    input: any,
    options?: any
  ): Promise<any> {
    if (agent instanceof SandboxAgent) receivedSandboxes.push(options?.runConfig?.sandbox);
    return originalTemporalRun.call(this, agent, input, options);
  } as any;
  const originalRunnerRun = Runner.prototype.run;
  Runner.prototype.run = async function (agent: any): Promise<any> {
    if (agent instanceof SandboxAgent) return { interruptions: [], finalOutput: 'done' };
    const output = await (agent.tools[0] as FunctionTool).invoke({} as RunContext<any>, '{"input":"hi"}');
    return { interruptions: [], finalOutput: output };
  } as any;
  const originalActivator = globalThis.__TEMPORAL_ACTIVATOR__;
  globalThis.__TEMPORAL_ACTIVATOR__ = { info: { workflowId: 'test', runId: 'test' } } as any;
  try {
    const runner = new TemporalOpenAIRunner();
    for (const sandbox of sandboxes) {
      const result = await runner.run(parent, 'hi', { runConfig: { sandbox } });
      t.is(result.finalOutput, 'done');
    }
    t.deepEqual(receivedSandboxes, sandboxes);
    t.is(parent.tools[0], tool);
  } finally {
    globalThis.__TEMPORAL_ACTIVATOR__ = originalActivator;
    Runner.prototype.run = originalRunnerRun;
    TemporalOpenAIRunner.prototype.run = originalTemporalRun;
  }
});

test.serial('agentAsTool: nested SandboxAgent without parent sandbox config fails', async (t) => {
  const sandboxAgent = new SandboxAgent({ name: 'Sandbox specialist', model: 'gpt-4o-mini' });
  const tool = agentAsTool(sandboxAgent, { toolName: 'ask_sandbox' });
  const parent = new Agent({ name: 'Parent', model: 'gpt-4o-mini', tools: [tool] });
  const originalRunnerRun = Runner.prototype.run;
  Runner.prototype.run = async function (agent: any): Promise<any> {
    const output = await (agent.tools[0] as FunctionTool).invoke({} as RunContext<any>, '{"input":"hi"}');
    return { interruptions: [], finalOutput: output };
  } as any;
  const originalActivator = globalThis.__TEMPORAL_ACTIVATOR__;
  globalThis.__TEMPORAL_ACTIVATOR__ = { info: { workflowId: 'test', runId: 'test' } } as any;
  try {
    const err = await t.throwsAsync(() => new TemporalOpenAIRunner().run(parent, 'hi'));
    t.true(err instanceof ApplicationFailure);
    t.is((err as ApplicationFailure).type, 'SandboxConfigurationError');
  } finally {
    globalThis.__TEMPORAL_ACTIVATOR__ = originalActivator;
    Runner.prototype.run = originalRunnerRun;
  }
});

test('extractToolOutput: throws NestedAgentInterruption when nested run has interruptions', async (t) => {
  const result = {
    interruptions: [{} as any],
    finalOutput: undefined,
  } as unknown as RunResult<any, Agent<any, any>>;
  const err = await t.throwsAsync(() => extractToolOutput(result, specialist.name, { toolName: 'ask_specialist' }));
  t.true(err instanceof ApplicationFailure);
  t.is((err as ApplicationFailure).type, 'NestedAgentInterruption');
  t.is((err as ApplicationFailure).nonRetryable, true);
  t.regex((err as Error).message, /ask_specialist/);
});
