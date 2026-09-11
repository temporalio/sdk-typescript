/**
 * Workflow fixtures for ADK 2.0's workflow (graph) runtime and dynamic nodes.
 * Bundled into the sandbox through `workflows.ts`, which re-exports this module.
 *
 * Every fixture runs the *native* ADK runtime inside the Workflow; the plugin
 * routes only model and Activity-node I/O to Activities.
 */

import {
  App,
  BasePlugin,
  createEvent,
  createResumabilityConfig,
  DEFAULT_ROUTE,
  InMemoryRunner,
  isFinalResponse,
  JoinNode,
  LlmAgent,
  node,
  stringifyContent,
  TruncatingContextCompactor,
  Workflow,
  type BaseNode,
  type Event,
  type LlmResponse,
  type NodeContext,
  type RunnableRoot,
} from '@google/adk';
import { Type } from '@google/genai';
import { z } from 'zod';

import { activityNode, markModelFailureHandled, TemporalModel, type TemporalModelOptions } from '../workflow';

const USER = 'test-user';

/** Per-turn Activity options: fail on the first attempt. */
const SINGLE_ATTEMPT: TemporalModelOptions = { activity: { retry: { maximumAttempts: 1 } } };

interface RunOutcome {
  /** The last `output` any event carried — the graph's result. */
  output: unknown;
  /** The last final response's text. */
  text: string;
  /** Node names in the order their events were seen. */
  nodes: string[];
  /** The last `errorMessage` any event carried (an error ADK absorbed into an event). */
  errorMessage?: string;
}

/** Runs one ephemeral turn against `root` and collects what came out. */
async function runOnce(root: RunnableRoot, prompt: string, plugins?: BasePlugin[]): Promise<RunOutcome> {
  const runner = new InMemoryRunner({ agent: root, plugins });
  return collect(runner.runEphemeral({ userId: USER, newMessage: { role: 'user', parts: [{ text: prompt }] } }));
}

async function collect(events: AsyncIterable<Event>): Promise<RunOutcome> {
  const outcome: RunOutcome = { output: undefined, text: '', nodes: [] };
  for await (const event of events) {
    if (event.errorMessage) outcome.errorMessage = event.errorMessage;
    if (event.output !== undefined) outcome.output = event.output;
    if (isFinalResponse(event)) outcome.text = stringifyContent(event);
    const path = event.nodeInfo?.path;
    if (path) outcome.nodes.push(path);
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Graph runtime
// ---------------------------------------------------------------------------

/** START → fetchData → summarize, both Temporal Activities. */
export async function graphSequential(query: string): Promise<RunOutcome> {
  const graph = new Workflow({
    name: 'sequential',
    edges: [['START', activityNode({ name: 'fetchData', args: () => [query] }), activityNode({ name: 'summarize' })]],
  });
  return runOnce(graph, 'go');
}

/** A router node picks a route; only that branch's Activity runs. */
export async function graphRouting(route: string): Promise<RunOutcome> {
  const router = node((_ctx: NodeContext, _input: unknown) => createEvent({ route, output: route }), {
    name: 'router',
  });
  const graph = new Workflow({
    name: 'routing',
    edges: [
      ['START', router],
      [
        router,
        {
          approve: activityNode({ name: 'approveActivity', args: () => [] }),
          [DEFAULT_ROUTE]: activityNode({ name: 'rejectActivity', args: () => [] }),
        },
      ],
    ],
  });
  return runOnce(graph, 'go');
}

/** Two Activity nodes fan out from START and join; the join's input is keyed by node name. */
export async function graphFanOutJoin(): Promise<RunOutcome> {
  const enrichA = activityNode({ name: 'enrichItem', nodeName: 'enrich_a', args: () => ['alpha'] });
  const enrichB = activityNode({ name: 'enrichItem', nodeName: 'enrich_b', args: () => ['beta'] });
  const join = new JoinNode({ name: 'join' });
  const final = node((_ctx: NodeContext, results: Record<string, unknown>) => results, { name: 'final' });
  const graph = new Workflow({
    name: 'fan_out_join',
    edges: [
      ['START', enrichA, join],
      ['START', enrichB, join],
      [join, final],
    ],
  });
  return runOnce(graph, 'go');
}

/** An `LlmAgent` in task mode as a graph node; its `finish_task` call is the node's output. */
export async function graphAgentTaskNode(prompt: string): Promise<RunOutcome> {
  const agent = new LlmAgent({
    name: 'tasker',
    model: new TemporalModel('finish-task-model'),
    mode: 'task',
    instruction: 'Finish the task.',
  });
  const graph = new Workflow({ name: 'task_graph', edges: [['START', agent]] });
  return runOnce(graph, prompt);
}

/** A 1-second node deadline around a 20-second Activity: ADK times the node out and cancels the Activity. */
export async function graphTimeout(): Promise<RunOutcome> {
  const graph = new Workflow({
    name: 'timeout_graph',
    edges: [
      [
        'START',
        activityNode({
          name: 'slowActivity',
          args: () => [],
          timeout: 1,
          activity: { startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 1 } },
        }),
      ],
    ],
  });
  return runOnce(graph, 'go');
}

/** ADK's node retry (with jitter) re-runs a non-retryable Activity failure twice before it succeeds. */
export async function graphRetry(jitter: number): Promise<RunOutcome> {
  const graph = new Workflow({
    name: 'retry_graph',
    edges: [
      [
        'START',
        activityNode({
          name: 'flakyActivity',
          args: () => [],
          retryConfig: { maxAttempts: 3, initialDelay: 0.05, jitter, exceptions: ['ActivityFailure'] },
          activity: { retry: { maximumAttempts: 1 } },
        }),
      ],
    ],
  });
  return runOnce(graph, 'go');
}

/** A node whose Activity fails for good: the failure must fail the Workflow. */
export async function graphActivityFailure(): Promise<RunOutcome> {
  const graph = new Workflow({
    name: 'failing_graph',
    edges: [
      ['START', activityNode({ name: 'failingActivity', args: () => [], activity: { retry: { maximumAttempts: 1 } } })],
    ],
  });
  return runOnce(graph, 'go');
}

/** An ADK plugin that substitutes a response for a failed model call. */
class RecoveringPlugin extends BasePlugin {
  constructor() {
    super('recovering');
  }

  override async onModelErrorCallback({ error }: { error: Error }): Promise<LlmResponse | undefined> {
    markModelFailureHandled(error);
    return createEvent({
      author: 'assistant',
      content: { role: 'model', parts: [{ text: 'recovered' }] },
      turnComplete: true,
    });
  }
}

/**
 * An `LlmAgent` node whose model call fails. ADK absorbs the model error and the
 * node ends without output; the plugin surfaces the recorded model failure —
 * unless an `onModelErrorCallback` recovers it.
 */
export async function graphAgentNodeModelFailure(model: string, recover: boolean): Promise<RunOutcome> {
  const agent = new LlmAgent({
    name: 'assistant',
    model: new TemporalModel(model, SINGLE_ATTEMPT),
    instruction: 'Help.',
  });
  const graph = new Workflow({ name: 'agent_node_graph', edges: [['START', agent]] });
  return runOnce(graph, 'hi', recover ? [new RecoveringPlugin()] : undefined);
}

/** A plugin observing ADK 2.0's node callbacks. */
class NodeCallbackPlugin extends BasePlugin {
  readonly seen: string[] = [];

  constructor() {
    super('node-callbacks');
  }

  override async beforeNodeCallback({ node: n }: { node: BaseNode }): Promise<unknown> {
    this.seen.push(`before:${n.name}`);
    return undefined;
  }

  override async afterNodeCallback({ node: n }: { node: BaseNode }): Promise<unknown> {
    this.seen.push(`after:${n.name}`);
    return undefined;
  }
}

export async function graphPluginNodeCallbacks(): Promise<string[]> {
  const plugin = new NodeCallbackPlugin();
  const graph = new Workflow({
    name: 'callbacks_graph',
    edges: [['START', activityNode({ name: 'fetchData', args: () => ['cb'] })]],
  });
  await runOnce(graph, 'go', [plugin]);
  return plugin.seen;
}

/** An `App` root with resumability enabled, run through `InMemoryRunner({ app })`. */
export async function appRoot(prompt: string): Promise<string> {
  const app = new App({
    name: 'adk_app',
    rootAgent: new LlmAgent({ name: 'assistant', model: new TemporalModel('fake-model'), instruction: 'Help.' }),
    resumabilityConfig: createResumabilityConfig({ isResumable: true }),
  });
  const runner = new InMemoryRunner({ app });
  const { text } = await collect(
    runner.runEphemeral({ userId: USER, newMessage: { role: 'user', parts: [{ text: prompt }] } })
  );
  return text;
}

/** Several turns in one session with a truncating context compactor attached to the agent. */
export async function compactedAgent(turns: number): Promise<string[]> {
  const agent = new LlmAgent({
    name: 'assistant',
    model: new TemporalModel('fake-model'),
    instruction: 'Help.',
    contextCompactors: [new TruncatingContextCompactor({ threshold: 2 })],
  });
  const runner = new InMemoryRunner({ agent });
  const session = await runner.sessionService.createSession({ appName: runner.appName, userId: USER });
  const texts: string[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const { text } = await collect(
      runner.runAsync({
        userId: USER,
        sessionId: session.id,
        newMessage: { role: 'user', parts: [{ text: `turn-${turn}` }] },
      })
    );
    texts.push(text);
  }
  return texts;
}

// ---------------------------------------------------------------------------
// Dynamic nodes
// ---------------------------------------------------------------------------

/** A dynamic entry node runs an Activity node `n` times in a loop. */
export async function dynamicLoop(n: number): Promise<RunOutcome> {
  const enrich = activityNode({ name: 'enrichNumber', nodeName: 'enrich' });
  const driver = node(
    async (ctx: NodeContext, _input: unknown) => {
      const outputs: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const result = await ctx.runNode(enrich, i);
        outputs.push(result.output);
      }
      return outputs;
    },
    { name: 'driver', rerunOnResume: true }
  );
  return runOnce(new Workflow({ name: 'dynamic_loop', edges: [['START', driver]] }), 'go');
}

/** A dynamic entry node fans out two Activity nodes with `Promise.all`. */
export async function dynamicGather(): Promise<RunOutcome> {
  const enrich = activityNode({ name: 'enrichNumber', nodeName: 'enrich' });
  const driver = node(
    async (ctx: NodeContext, _input: unknown) => {
      const results = await Promise.all([ctx.runNode(enrich, 1), ctx.runNode(enrich, 2)]);
      return results.map((r) => r.output);
    },
    { name: 'driver', rerunOnResume: true }
  );
  return runOnce(new Workflow({ name: 'dynamic_gather', edges: [['START', driver]] }), 'go');
}

/**
 * A `Workflow` as a tool: ADK wraps it in a `NodeTool`. With a Zod `inputSchema`
 * the model sees real parameters; with a genai `Schema` ADK advertises a single
 * `request` string and passes it as the node input.
 */
export async function workflowAsTool(schema: 'zod' | 'genai-string' | 'genai-object'): Promise<RunOutcome> {
  const enrich = activityNode<unknown, string>({
    name: 'enrichNumber',
    nodeName: 'enrich',
    args: (input) => [typeof input === 'object' && input !== null ? (input as { value: number }).value : Number(input)],
  });
  const flow = new Workflow({
    name: 'enrich_flow',
    description: 'Enriches a number.',
    inputSchema:
      schema === 'zod'
        ? z.object({ value: z.number().describe('The number to enrich.') })
        : schema === 'genai-string'
          ? { type: Type.STRING, description: 'The number to enrich, as text.' }
          : { type: Type.OBJECT, properties: { value: { type: Type.NUMBER } } },
    edges: [['START', enrich]],
  });
  const agent = new LlmAgent({
    name: 'assistant',
    model: new TemporalModel(schema === 'zod' ? 'enrich-flow-model' : 'enrich-flow-genai-model'),
    instruction: 'Use the tool.',
    tools: [flow],
  });
  return runOnce(agent, 'enrich 7');
}
