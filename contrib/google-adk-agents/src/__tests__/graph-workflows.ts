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
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  RequestInput,
  stringifyContent,
  TruncatingContextCompactor,
  Workflow,
  type BaseNode,
  type Event,
  type LlmResponse,
  type NodeContext,
  type RunnableRoot,
} from '@google/adk';
import { Type, type Part } from '@google/genai';
import { z } from 'zod';
import { ActivityCancellationType, sleep } from '@temporalio/workflow';

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

/**
 * An Activity node whose Activity returns nothing, followed by a node reporting the input
 * it received. The node completes with a `null` output and its successor still runs,
 * which is what ADK's `waitForOutput` would have parked forever.
 */
export async function graphVoidOutput(): Promise<RunOutcome> {
  const after = node((_ctx: NodeContext, received: unknown) => ({ received }), { name: 'after' });
  const graph = new Workflow({
    name: 'void_output',
    edges: [['START', activityNode({ name: 'voidActivity', args: () => [] }), after]],
  });
  return runOnce(graph, 'go');
}

/**
 * Runs `graph` over two turns of one session: the first pauses at the `approve` interrupt,
 * and the second answers it with an `adk_request_input` function response, the way a
 * client resumes a paused graph. Returns the second turn's outcome.
 */
async function approveAfterPause(graph: Workflow): Promise<RunOutcome> {
  const runner = new InMemoryRunner({ agent: graph });
  const session = await runner.sessionService.createSession({ appName: runner.appName, userId: USER });
  await collect(
    runner.runAsync({ userId: USER, sessionId: session.id, newMessage: { role: 'user', parts: [{ text: 'go' }] } })
  );
  const answer: Part = {
    functionResponse: { id: 'approve', name: REQUEST_INPUT_FUNCTION_CALL_NAME, response: { result: 'yes' } },
  };
  return collect(
    runner.runAsync({ userId: USER, sessionId: session.id, newMessage: { role: 'user', parts: [answer] } })
  );
}

/**
 * START, an Activity node, then a node that pauses for input, run over the two turns of
 * {@link approveAfterPause}. The Activity node completed before the pause, so on resume
 * ADK has to fast-forward it from the session's events rather than schedule the Activity
 * again. Returns the second turn's outcome.
 */
export async function graphActivityThenPause(activityName: string, nodeName?: string): Promise<RunOutcome> {
  const work = activityNode({ name: activityName, nodeName, args: () => [] });
  const ask = node(() => new RequestInput({ interruptId: 'approve', message: 'Continue?' }), { name: 'ask' });
  return approveAfterPause(new Workflow({ name: 'pause_after_activity', edges: [['START', work, ask]] }));
}

/**
 * The same two turns after an Activity whose result carries a `parts` array, the shape
 * ADK's `FunctionNode` takes for genai `Content`. The pausing node reruns once answered
 * and then outputs `{ received, answer }`: `received` is the input the Activity node
 * handed it, so the second turn's output shows what reached the successor.
 */
export async function graphPartsPayloadThenPause(): Promise<RunOutcome> {
  const work = activityNode({ name: 'partsPayload', args: () => [] });
  const ask = node(
    (ctx: NodeContext, received: unknown) => {
      const answer = ctx.resumeInputs['approve'];
      if (answer === undefined) return new RequestInput({ interruptId: 'approve', message: 'Continue?' });
      return { received, answer };
    },
    { name: 'ask', rerunOnResume: true }
  );
  return approveAfterPause(new Workflow({ name: 'pause_after_parts_payload', edges: [['START', work, ask]] }));
}

/** A dotted Activity type reaches the graph under a path-safe `nodeName`. */
export async function graphDottedActivity(): Promise<RunOutcome> {
  const graph = new Workflow({
    name: 'dotted_activity',
    edges: [['START', activityNode({ name: 'payments.charge', nodeName: 'payments_charge', args: () => [] })]],
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

/** Activity options for a node whose deadline has to cancel an Activity that outlives it. */
const CANCELLABLE: TemporalModelOptions['activity'] = {
  startToCloseTimeout: '60 seconds',
  // Wait for the Activity to acknowledge, which it does on its next heartbeat.
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  heartbeatTimeout: '2 seconds',
  retry: { maximumAttempts: 1 },
};

/** A 1-second node deadline around a much longer Activity: the node times out and cancels it. */
export async function graphTimeout(): Promise<RunOutcome> {
  const graph = new Workflow({
    name: 'timeout_graph',
    edges: [
      ['START', activityNode({ name: 'cancellableActivity', args: () => [], timeout: 1, activity: CANCELLABLE })],
    ],
  });
  return runOnce(graph, 'go');
}

/** The same deadline with an ADK node retry: the second attempt must not overlap the first. */
export async function graphTimeoutRetry(): Promise<RunOutcome> {
  const graph = new Workflow({
    name: 'timeout_retry_graph',
    edges: [
      [
        'START',
        activityNode({
          name: 'cancellableActivity',
          args: () => [],
          timeout: 1,
          retryConfig: { maxAttempts: 2, initialDelay: 0.01, jitter: 0, exceptions: ['NodeTimeoutError'] },
          activity: CANCELLABLE,
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

/**
 * An `LlmAgent` whose model call only cancellation can end, with the Activity options
 * `cancellableModelCall` uses, so the Workflow waits for the cancel to land and history
 * shows how the model Activity ended.
 */
function cancellableAgent(): LlmAgent {
  return new LlmAgent({
    name: 'assistant',
    model: new TemporalModel('abort-model', {
      activity: {
        startToCloseTimeout: '20 seconds',
        heartbeatTimeout: '6 seconds',
        retry: { maximumAttempts: 3, initialInterval: '1 second' },
        cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
      },
    }),
    instruction: 'Help.',
  });
}

/**
 * A {@link cancellableAgent} as a graph node. ADK absorbs the cancelled call like any
 * other model error and then reports the node as failed (`NodeReportedError`).
 */
export async function graphCancellableAgentNode(): Promise<RunOutcome> {
  return runOnce(new Workflow({ name: 'cancellable_agent_graph', edges: [['START', cancellableAgent()]] }), 'hi');
}

/**
 * A {@link cancellableAgent} node beside a branch that fails once the model call is under
 * way: a one-second durable timer, then an Activity that fails for good. ADK aborts the
 * run's signal when that Activity node fails and waits for the agent node to unwind before
 * failing the run, which the agent node can only do once its model Activity has ended.
 */
export async function graphAgentNodeWithFailingSibling(): Promise<RunOutcome> {
  // The timer only orders the failure after the model call has started.
  const wait = node(
    async () => {
      await sleep('1 second');
      return 'waited';
    },
    { name: 'wait' }
  );
  const failing = activityNode({
    name: 'failingActivity',
    args: () => [],
    activity: { retry: { maximumAttempts: 1 } },
  });
  return runOnce(
    new Workflow({
      name: 'agent_beside_failing_sibling',
      edges: [
        ['START', cancellableAgent()],
        ['START', wait, failing],
      ],
    }),
    'hi'
  );
}

/**
 * An `LlmAgent` node whose first model call fails and whose retry succeeds. ADK absorbed
 * the first failure into an event, so the run finishes normally and the plugin must not
 * raise the attempt ADK already recovered from.
 */
export async function graphRetriedAgentNode(): Promise<RunOutcome> {
  const agent = new LlmAgent({
    name: 'assistant',
    model: new TemporalModel('fail-first-model', SINGLE_ATTEMPT),
    instruction: 'Help.',
  });
  const graph = new Workflow({
    name: 'retried_agent_graph',
    edges: [
      [
        'START',
        node(agent, {
          name: 'assistant',
          retryConfig: { maxAttempts: 2, initialDelay: 0.01, jitter: 0, exceptions: ['NodeReportedError'] },
        }),
      ],
    ],
  });
  return runOnce(graph, 'hi');
}

/**
 * Two agents run in order, the first one's model fails, the graph swallows its error and
 * the second one answers, so the run finishes normally with a failure nobody recovered
 * from. A success belongs to the agent that made the call, so the first agent's recording
 * still ends the Workflow.
 */
export async function twoAgentsOneFailureSwallowed(): Promise<RunOutcome> {
  const failing = new LlmAgent({
    name: 'failing_agent',
    model: new TemporalModel('boom', SINGLE_ATTEMPT),
    instruction: 'Help.',
  });
  const healthy = new LlmAgent({ name: 'healthy_agent', model: new TemporalModel('fake-model'), instruction: 'Help.' });
  const driver = node(
    async (ctx: NodeContext) => {
      try {
        await ctx.runNode(failing, 'hi');
      } catch {
        // The graph carries on; only the plugin still knows the model call failed.
      }
      return (await ctx.runNode(healthy, 'hi')).output;
    },
    { name: 'driver', rerunOnResume: true }
  );
  return runOnce(new Workflow({ name: 'two_agents', edges: [['START', driver]] }), 'hi');
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

/**
 * Several turns in one session with a truncating context compactor attached to the agent.
 * The model reports how many `contents` each request carried, which is what the compactor
 * truncates: uncompacted, a turn would add two.
 */
export async function compactedAgent(turns: number): Promise<string[]> {
  const agent = new LlmAgent({
    name: 'assistant',
    model: new TemporalModel('contents-counting-model'),
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

/** A dynamic node whose Activity fails for good. ADK wraps a dynamic child's error in a `DynamicNodeFailError`. */
export async function dynamicActivityFailure(): Promise<RunOutcome> {
  const failing = activityNode({
    name: 'failingActivity',
    args: () => [],
    activity: { retry: { maximumAttempts: 1 } },
  });
  const driver = node(async (ctx: NodeContext) => (await ctx.runNode(failing, undefined)).output, {
    name: 'driver',
    rerunOnResume: true,
  });
  return runOnce(new Workflow({ name: 'dynamic_failure', edges: [['START', driver]] }), 'go');
}

/**
 * A dynamic node running an `LlmAgent` whose model call fails. ADK absorbs the model
 * error into a `NodeReportedError` and the dynamic scheduler wraps that in a
 * `DynamicNodeFailError`, so the recorded model failure is two carriers deep.
 */
export async function dynamicAgentModelFailure(): Promise<RunOutcome> {
  const agent = new LlmAgent({
    name: 'assistant',
    model: new TemporalModel('boom', SINGLE_ATTEMPT),
    instruction: 'Help.',
  });
  const driver = node(async (ctx: NodeContext) => (await ctx.runNode(agent, 'hi')).output, {
    name: 'driver',
    rerunOnResume: true,
  });
  return runOnce(new Workflow({ name: 'dynamic_agent_failure', edges: [['START', driver]] }), 'go');
}

/**
 * A dynamic node running an Activity that outlives the test. `TRY_CANCEL` reports the
 * cancellation to the Workflow without waiting for the Activity to wind down, so the run
 * ends as soon as the Workflow is cancelled.
 */
export async function dynamicCancellation(): Promise<RunOutcome> {
  const slow = activityNode({
    name: 'slowActivity',
    args: () => [],
    activity: {
      startToCloseTimeout: '30 seconds',
      cancellationType: ActivityCancellationType.TRY_CANCEL,
      retry: { maximumAttempts: 1 },
    },
  });
  const driver = node(async (ctx: NodeContext) => (await ctx.runNode(slow, undefined)).output, {
    name: 'driver',
    rerunOnResume: true,
  });
  return runOnce(new Workflow({ name: 'dynamic_cancel', edges: [['START', driver]] }), 'go');
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
