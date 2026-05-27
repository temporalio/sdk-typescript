// eslint-disable-next-line import/no-unassigned-import
import '../../load-polyfills';
import { z } from 'zod';
import {
  AfterToolCallEvent,
  tool,
  type InterruptResponseContent,
  type InterruptResponseContentData,
} from '@strands-agents/sdk';
import { defineSignal, setHandler, condition } from '@temporalio/workflow';
import { WorkflowStream } from '@temporalio/workflow-streams/workflow';
import { TemporalAgent, TemporalMCPClient, workflow as strandsWorkflow } from '../..';

export async function helloAgent(prompt: string): Promise<string> {
  const agent = new TemporalAgent({ model: 'test', printer: false });
  const result = await agent.invoke(prompt);
  return result.toString();
}

export async function activityToolAgent(prompt: string): Promise<string> {
  const agent = new TemporalAgent({
    model: 'test',
    printer: false,
    tools: [
      strandsWorkflow.activityAsTool('getWeather', {
        description: 'Get the weather for a city',
        inputSchema: {
          type: 'object',
          properties: {
            location: { type: 'string' },
          },
          required: ['location'],
        },
        activityOptions: { startToCloseTimeout: '10 seconds' },
      }),
    ],
  });
  const result = await agent.invoke(prompt);
  return result.toString();
}

export async function mcpAgent(prompt: string): Promise<string> {
  const mcp = new TemporalMCPClient({
    server: 'testServer',
    activityOptions: { startToCloseTimeout: '10 seconds' },
  });
  const agent = new TemporalAgent({
    model: 'test',
    printer: false,
    tools: [mcp],
  });
  const result = await agent.invoke(prompt);
  return result.toString();
}

const echoTool = tool({
  name: 'echo',
  description: 'Echo back the input text',
  inputSchema: z.object({ text: z.string() }),
  callback: ({ text }) => text,
});

export async function inWorkflowToolAgent(prompt: string): Promise<string> {
  const agent = new TemporalAgent({
    model: 'test',
    printer: false,
    tools: [echoTool],
  });
  const result = await agent.invoke(prompt);
  return result.toString();
}

export async function hooksAgent(prompt: string): Promise<string[]> {
  const firedEvents: string[] = [];
  const agent = new TemporalAgent({
    model: 'test',
    printer: false,
    tools: [echoTool],
  });
  // Sync hook — deterministic per-workflow state mutation.
  agent.addHook(AfterToolCallEvent, (event) => {
    firedEvents.push(event.toolUse.name);
  });
  // Activity-as-hook — dispatches `auditTool` activity.
  agent.addHook(
    AfterToolCallEvent,
    strandsWorkflow.activityAsHook('auditTool', {
      activityInput: (event) => event.toolUse.name,
      activityOptions: { startToCloseTimeout: '10 seconds' },
    })
  );
  await agent.invoke(prompt);
  return firedEvents;
}

const PersonInfo = z.object({
  name: z.string(),
  age: z.number(),
  occupation: z.string(),
});

export async function structuredOutputAgent(prompt: string): Promise<unknown> {
  const agent = new TemporalAgent({
    model: 'test',
    printer: false,
    structuredOutputSchema: PersonInfo,
  });
  const result = await agent.invoke(prompt);
  return result.structuredOutput;
}

export const approveSignal = defineSignal<[string]>('approve');

export async function interruptAgent(prompt: string): Promise<string> {
  let approval: string | null = null;
  setHandler(approveSignal, (response: string) => {
    approval = response;
  });

  const agent = new TemporalAgent({
    model: 'test',
    printer: false,
    tools: [
      strandsWorkflow.activityAsTool('deleteThing', {
        description: 'Delete a thing',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        activityOptions: { startToCloseTimeout: '10 seconds' },
      }),
    ],
  });

  let result = await agent.invoke(prompt);
  while (result.stopReason === 'interrupt') {
    await condition(() => approval !== null);
    const response = approval;
    approval = null;
    const responses: InterruptResponseContentData[] = (result.interrupts ?? []).map((i) => ({
      type: 'interruptResponse',
      interruptResponse: { interruptId: i.id, response },
    }));
    result = await agent.invoke(responses as InterruptResponseContent[]);
  }
  return result.toString();
}

export async function streamingAgent(prompt: string): Promise<string> {
  // Constructing the stream installs the publish/poll handlers the client uses
  // to drain the `model` topic; nothing in this function reads from it.
  void new WorkflowStream();
  const agent = new TemporalAgent({
    model: 'test',
    printer: false,
    streamingTopic: 'model',
  });
  const result = await agent.invoke(prompt);
  return result.toString();
}
