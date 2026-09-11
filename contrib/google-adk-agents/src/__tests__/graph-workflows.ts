/**
 * Workflow fixtures for ADK 2.0's workflow (graph) runtime, dynamic nodes and
 * durable human-in-the-loop. Bundled into the sandbox through `workflows.ts`,
 * which re-exports this module.
 *
 * Every fixture runs the *native* ADK runtime inside the Workflow; the plugin
 * routes only model, Activity-node, activity-tool and MCP I/O to Activities.
 */

import {
  App,
  BasePlugin,
  BaseTool,
  createEvent,
  createResumabilityConfig,
  DEFAULT_ROUTE,
  InMemoryRunner,
  isFinalResponse,
  JoinNode,
  LlmAgent,
  node,
  PolicyOutcome,
  RequestInput,
  requestInputTool,
  SecurityPlugin,
  stringifyContent,
  TruncatingContextCompactor,
  Workflow,
  type BaseNode,
  type BasePolicyEngine,
  type Event,
  type LlmResponse,
  type NodeContext,
  type PolicyCheckResult,
  type RunAsyncToolRequest,
  type RunConfig,
  type Runner,
  type RunnableRoot,
  type ToolCallPolicyContext,
} from '@google/adk';
import type { Content, FunctionDeclaration, Part } from '@google/genai';
import { Type } from '@google/genai';
import { z } from 'zod';
import { condition, defineQuery, defineUpdate, setHandler } from '@temporalio/workflow';

import {
  activityAsTool,
  activityNode,
  hitlConfirmationResponse,
  hitlInputResponse,
  markModelFailureHandled,
  pendingHitlRequests,
  TemporalMCPToolset,
  TemporalModel,
  type HitlConfirmation,
  type HitlRequest,
  type TemporalModelOptions,
} from '../workflow';

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

// ---------------------------------------------------------------------------
// Durable human-in-the-loop
// ---------------------------------------------------------------------------

/** Pending pauses of the current turn. */
export const pendingHitlQuery = defineQuery<HitlRequest[]>('pendingHitl');
/** Records the human's answer for an interrupt id: a value for `input`, `{ confirmed }` for `confirmation`. */
export const respondHitlUpdate = defineUpdate<void, [string, unknown]>('respondHitl');
/** Sends the next turn as plain text instead of structured responses. */
export const plainTextTurnUpdate = defineUpdate<void, [string]>('plainTextTurn');
/**
 * Answers an interrupt with an ordinary text turn and marks it answered locally.
 * For an `adk_request_input` raised by a plain `LlmAgent` (ADK's `requestInputTool`),
 * ADK 2.0 strips the framework call and its function response from the model's
 * context, so only a text reply reaches the model — and ADK's own pending list
 * clears only on a function response, so the loop tracks the answer itself.
 */
export const answerAsTextUpdate = defineUpdate<void, [string, string]>('answerAsText');

interface HitlState {
  pending: HitlRequest[];
  answers: Map<string, unknown>;
  textAnswers: Map<string, string>;
  /** Interrupts answered with text: ADK still lists them, the loop does not. */
  answered: Set<string>;
  plainText?: string;
}

function installHitlHandlers(): HitlState {
  const state: HitlState = { pending: [], answers: new Map(), textAnswers: new Map(), answered: new Set() };
  setHandler(pendingHitlQuery, () => state.pending);
  setHandler(respondHitlUpdate, (interruptId, value) => {
    state.answers.set(interruptId, value);
  });
  setHandler(plainTextTurnUpdate, (text) => {
    state.plainText = text;
  });
  setHandler(answerAsTextUpdate, (interruptId, text) => {
    state.textAnswers.set(interruptId, text);
  });
  return state;
}

/**
 * The durable HITL loop: run a turn; while pauses are pending, expose them,
 * wait for answers through the Update, and run the next turn with the
 * answers as user-authored function responses (all of them in one message).
 */
async function runWithHitl(
  root: RunnableRoot,
  prompt: string,
  options: { plugins?: BasePlugin[]; runner?: Runner } = {}
): Promise<RunOutcome & { turns: number }> {
  const state = installHitlHandlers();
  const runner = options.runner ?? new InMemoryRunner({ agent: root, plugins: options.plugins });
  const session = await runner.sessionService.createSession({ appName: runner.appName, userId: USER });
  let newMessage: Content = { role: 'user', parts: [{ text: prompt }] };
  let runConfig: RunConfig | undefined;
  let turns = 0;
  for (;;) {
    turns++;
    const outcome = await collect(runner.runAsync({ userId: USER, sessionId: session.id, newMessage, runConfig }));
    runConfig = undefined;
    const current = await runner.sessionService.getSession({
      appName: runner.appName,
      userId: USER,
      sessionId: session.id,
    });
    const pending = pendingHitlRequests(current?.events ?? []).filter((r) => !state.answered.has(r.interruptId));
    state.pending = pending;
    if (pending.length === 0) return { ...outcome, turns };

    await condition(
      () =>
        state.plainText !== undefined ||
        pending.some((r) => state.answers.has(r.interruptId) || state.textAnswers.has(r.interruptId))
    );
    if (state.plainText !== undefined) {
      // A plain-text approval runs the tool but never answers the gate's function
      // call, so ADK keeps listing it; the loop marks it answered itself.
      for (const r of pending) state.answered.add(r.interruptId);
      newMessage = { role: 'user', parts: [{ text: state.plainText }] };
      runConfig = { plainTextToolConfirmation: true } as RunConfig;
      state.plainText = undefined;
      continue;
    }
    const textAnswered = pending.filter((r) => state.textAnswers.has(r.interruptId));
    if (textAnswered.length > 0) {
      const parts: Part[] = textAnswered.map((r) => ({ text: state.textAnswers.get(r.interruptId)! }));
      for (const r of textAnswered) {
        state.textAnswers.delete(r.interruptId);
        state.answered.add(r.interruptId);
      }
      newMessage = { role: 'user', parts };
      continue;
    }
    const answered = pending.filter((r) => state.answers.has(r.interruptId));
    const parts: Part[] = answered.map((request) => {
      const value = state.answers.get(request.interruptId);
      state.answers.delete(request.interruptId);
      return request.kind === 'confirmation'
        ? hitlConfirmationResponse(request, value as HitlConfirmation)
        : hitlInputResponse(request, value);
    });
    newMessage = { role: 'user', parts };
  }
}

/** START → a node that pauses for input → a node that uses the answer. */
export async function hitlInputNode(): Promise<RunOutcome & { turns: number }> {
  const ask = node(
    async function* () {
      yield new RequestInput({ interruptId: 'approval', message: 'Approve the release?' });
    },
    { name: 'ask' }
  );
  const answer = node((_ctx: NodeContext, input: unknown) => `approved:${String(input)}`, { name: 'answer' });
  return runWithHitl(new Workflow({ name: 'hitl_input', edges: [['START', ask, answer]] }), 'go');
}

/** A `RequestInput` with no explicit id: ADK mints one, which must replay identically. */
export async function hitlDefaultInterruptId(): Promise<RunOutcome & { turns: number }> {
  const ask = node(() => new RequestInput({ message: 'Name?' }), { name: 'ask' });
  const answer = node((_ctx: NodeContext, input: unknown) => `hello:${String(input)}`, { name: 'answer' });
  return runWithHitl(new Workflow({ name: 'hitl_default_id', edges: [['START', ask, answer]] }), 'go');
}

/** Two pauses raised in parallel, joined: partial answers keep the other pending. */
export async function hitlTwoPending(): Promise<RunOutcome & { turns: number }> {
  const askA = node(() => new RequestInput({ interruptId: 'a', message: 'A?' }), { name: 'ask_a' });
  const askB = node(() => new RequestInput({ interruptId: 'b', message: 'B?' }), { name: 'ask_b' });
  const join = new JoinNode({ name: 'join' });
  const final = node(
    (_ctx: NodeContext, results: Record<string, unknown>) => `${String(results['ask_a'])}&${String(results['ask_b'])}`,
    { name: 'final' }
  );
  return runWithHitl(
    new Workflow({
      name: 'hitl_two',
      edges: [
        ['START', askA, join],
        ['START', askB, join],
        [join, final],
      ],
    }),
    'go'
  );
}

/** An agent raises the pause itself through ADK's `requestInputTool`. */
export async function hitlAgentRequestInput(): Promise<RunOutcome & { turns: number }> {
  const agent = new LlmAgent({
    name: 'assistant',
    model: new TemporalModel('request-input-model'),
    instruction: 'Ask the user.',
    tools: [requestInputTool],
  });
  return runWithHitl(agent, 'start');
}

const dangerParameters = {
  type: Type.OBJECT,
  properties: { target: { type: Type.STRING, description: 'Deployment target.' } },
  required: ['target'],
};

/** A confirmation-gated `activityAsTool`: the Activity runs only once approved. */
export async function hitlConfirmActivityTool(): Promise<RunOutcome & { turns: number }> {
  const agent = new LlmAgent({
    name: 'assistant',
    model: new TemporalModel('confirm-danger-model'),
    instruction: 'Deploy.',
    tools: [
      activityAsTool({
        name: 'dangerActivity',
        description: 'Dangerous.',
        parameters: dangerParameters,
        requireConfirmation: true,
      }),
    ],
  });
  return runWithHitl(agent, 'deploy to prod');
}

/** A confirmation-gated MCP toolset: the `<name>-callTool` Activity runs only once approved. */
export async function hitlConfirmMcpTool(): Promise<RunOutcome & { turns: number }> {
  const agent = new LlmAgent({
    name: 'assistant',
    model: new TemporalModel('confirm-echo-model'),
    instruction: 'Echo.',
    tools: [new TemporalMCPToolset({ name: 'testServer', requireConfirmation: true })],
  });
  return runWithHitl(agent, 'echo hello');
}

/**
 * A `BaseTool` that gates itself at run time without declaring it through
 * `checkRequireConfirmation`: ADK's resume path still binds the approval,
 * because the gate was requested by the tool's own agent-authored event.
 */
class DynamicGateTool extends BaseTool {
  constructor() {
    super({ name: 'dynamicGate', description: 'Gated at run time.' });
  }

  override _getDeclaration(): FunctionDeclaration {
    return { name: this.name, description: this.description, parameters: dangerParameters };
  }

  override async runAsync({ toolContext }: RunAsyncToolRequest): Promise<unknown> {
    if (!toolContext.toolConfirmation) {
      toolContext.requestConfirmation({ hint: 'Approve dynamicGate?' });
      toolContext.actions.skipSummarization = true;
      return { error: 'This tool call requires confirmation, please approve or reject.' };
    }
    if (!toolContext.toolConfirmation.confirmed) return { error: 'This tool call is rejected.' };
    return { ran: true };
  }
}

export async function hitlDynamicGateTool(): Promise<RunOutcome & { turns: number }> {
  const agent = new LlmAgent({
    name: 'assistant',
    model: new TemporalModel('confirm-gate-model'),
    instruction: 'Deploy.',
    tools: [new DynamicGateTool()],
  });
  return runWithHitl(agent, 'deploy to prod');
}

/** A policy engine that requires confirmation for `dangerActivity`. */
class ConfirmDangerPolicy implements BasePolicyEngine {
  async evaluate({ tool }: ToolCallPolicyContext): Promise<PolicyCheckResult> {
    return tool.name === 'dangerActivity'
      ? { outcome: PolicyOutcome.CONFIRM, reason: 'Dangerous tool.' }
      : { outcome: PolicyOutcome.ALLOW };
  }
}

/** ADK's `SecurityPlugin` gates an ungated activity tool through the same HITL loop. */
export async function hitlSecurityPlugin(): Promise<RunOutcome & { turns: number }> {
  const agent = new LlmAgent({
    name: 'assistant',
    model: new TemporalModel('confirm-danger-model'),
    instruction: 'Deploy.',
    tools: [activityAsTool({ name: 'dangerActivity', description: 'Dangerous.', parameters: dangerParameters })],
  });
  return runWithHitl(agent, 'deploy to prod', {
    plugins: [new SecurityPlugin({ policyEngine: new ConfirmDangerPolicy() })],
  });
}

/**
 * A dynamic driver runs an Activity child, then pauses for input; on resume the
 * driver body re-runs but the completed child is fast-forwarded from the session.
 */
export async function dynamicResume(): Promise<RunOutcome & { turns: number }> {
  const fetch = activityNode({ name: 'countedFetch', nodeName: 'fetch', args: () => ['step1'] });
  const approval = node(() => new RequestInput({ interruptId: 'approve', message: 'Continue?' }), {
    name: 'approval',
    rerunOnResume: false,
  });
  const driver = node(
    async (ctx: NodeContext, _input: unknown) => {
      const fetched = await ctx.runNode(fetch, undefined);
      const approved = await ctx.runNode(approval, fetched.output);
      if (approved.interruptIds.length > 0) return undefined;
      return `${String(fetched.output)}|${String(approved.output)}`;
    },
    { name: 'driver', rerunOnResume: true }
  );
  return runWithHitl(new Workflow({ name: 'dynamic_resume', edges: [['START', driver]] }), 'go');
}
