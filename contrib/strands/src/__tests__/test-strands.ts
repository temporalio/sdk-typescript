import type { TestFn } from 'ava';
import { McpClient, Message, Model, TextBlock } from '@strands-agents/sdk';
import type { BaseModelConfig, JSONValue, ModelStreamEvent, StreamOptions, Tool } from '@strands-agents/sdk';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { BaseContext } from '@temporalio/test-helpers';
import { test as anyTest, createBaseBundlerOptions, helpers, TestWorkflowEnvironment } from '@temporalio/test-helpers';
import { bundleWorkflowCode, DefaultLogger, Worker } from '@temporalio/worker';
import { WorkflowStreamClient } from '@temporalio/workflow-streams/client';
import { StrandsPlugin } from '..';
import { auditLog, auditTool, deleteState, deleteThing, getWeather, getWeatherCalls } from './activities/strands';
import {
  activityToolAgent,
  approveSignal,
  defaultModelAgent,
  helloAgent,
  hooksAgent,
  interruptAgent,
  inWorkflowToolAgent,
  mcpAgent,
  streamingAgent,
  structuredOutputAgent,
} from './workflows/strands';

const STUB_TRANSPORT: Transport = {
  async start() {},
  async send() {},
  async close() {},
};

/**
 * Stub `Model` whose `stream()` yields a deterministic sequence of events.
 * The Strands agent loop drives multiple model calls; this stub returns one
 * event sequence per call from the generator passed in.
 */
class StubModel extends Model<BaseModelConfig> {
  private readonly turns: ModelStreamEvent[][];
  private turnIndex = 0;

  constructor(turns: ModelStreamEvent[][]) {
    super();
    this.turns = turns;
  }

  override updateConfig(_: BaseModelConfig): void {}
  override getConfig(): BaseModelConfig {
    return {};
  }

  override async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    if (this.turnIndex >= this.turns.length) {
      throw new Error('StubModel exhausted: no more turns');
    }
    const events = this.turns[this.turnIndex++]!;
    for (const event of events) {
      yield event;
    }
  }
}

/** Convenience: text reply that ends the conversation. */
function textTurn(text: string): ModelStreamEvent[] {
  return [
    { type: 'modelMessageStartEvent', role: 'assistant' },
    { type: 'modelContentBlockStartEvent' },
    { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } },
    { type: 'modelContentBlockStopEvent' },
    { type: 'modelMessageStopEvent', stopReason: 'endTurn' },
  ];
}

/** Convenience: tool-call turn that the agent loop will dispatch. */
function toolCallTurn(toolName: string, toolUseId: string, input: object): ModelStreamEvent[] {
  return [
    { type: 'modelMessageStartEvent', role: 'assistant' },
    {
      type: 'modelContentBlockStartEvent',
      start: { type: 'toolUseStart', name: toolName, toolUseId },
    },
    {
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) },
    },
    { type: 'modelContentBlockStopEvent' },
    { type: 'modelMessageStopEvent', stopReason: 'toolUse' },
  ];
}

/**
 * Subclass of `McpClient` that returns a fixed tool list and a fixed call
 * result, with no real transport I/O. The per-server `{server}-listTools` and
 * `{server}-callTool` activities both call into this client.
 *
 * The plugin only reads `name`/`description`/`toolSpec.inputSchema` from the
 * returned tools and only uses `tool.name` when dispatching `callTool`, so the
 * stub returns minimal duck-typed objects.
 */
class StubMcpClient extends McpClient {
  private readonly toolList: Tool[];

  constructor(toolList: Array<{ name: string; description: string; inputSchema: unknown }>) {
    super({ transport: STUB_TRANSPORT });
    this.toolList = toolList.map(
      (t) =>
        ({
          name: t.name,
          description: t.description,
          toolSpec: {
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          },
        }) as unknown as Tool
    );
  }

  override async connect(): Promise<void> {}
  override async disconnect(): Promise<void> {}
  override async listTools(): Promise<never> {
    // McpClient.listTools returns `Promise<McpTool[]>` and `McpTool` isn't in
    // the public index; widen via `never` for the stub.
    return this.toolList as never;
  }
  override async callTool(tool: { name: string }, args: JSONValue): Promise<JSONValue> {
    return {
      content: [{ type: 'text', text: `mcp:${tool.name}(${JSON.stringify(args)})` }],
      isError: false,
    } as never;
  }
}

const test = anyTest as TestFn<BaseContext>;

test.before(async (t) => {
  const env = await TestWorkflowEnvironment.createLocal();
  // Pass a `StrandsPlugin` to `bundleWorkflowCode` so the plugin can stub out
  // `@strands-agents/sdk/mcp-config.js`'s dynamic `node:*`/MCP-transport
  // imports and inline async chunks.
  const bundlerPlugin = new StrandsPlugin({ models: { test: () => new StubModel([]) } });
  const workflowBundle = await bundleWorkflowCode({
    ...createBaseBundlerOptions(),
    workflowsPath: require.resolve('./workflows/strands'),
    logger: new DefaultLogger('WARN'),
    plugins: [bundlerPlugin],
  });
  t.context = { env, workflowBundle };
});

test.after.always(async (t) => {
  await t.context.env?.teardown();
});

test('TemporalAgent dispatches model.stream() through invokeModel activity', async (t) => {
  t.timeout(60_000);
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new StrandsPlugin({
        models: { test: () => new StubModel([textTurn('hello from stub')]) },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(helloAgent, {
      args: ['say hi'],
      workflowExecutionTimeout: '30 seconds',
    });
    t.is(result, 'hello from stub');
  });
});

test('TemporalAgent without `model:` resolves to the single registered factory', async (t) => {
  t.timeout(60_000);
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new StrandsPlugin({
        models: { onlyModel: () => new StubModel([textTurn('reply from default')]) },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(defaultModelAgent, {
      args: ['hi'],
      workflowExecutionTimeout: '30 seconds',
    });
    t.is(result, 'reply from default');
  });
});

test('invokeModel reconstructs Message instances from wire data', async (t) => {
  // Strands content-block and Message classes have lossy `toJSON()` methods.
  // After Temporal's default payload converter serializes activity input,
  // the receiving side sees plain Bedrock-shape objects without the `type`
  // discriminator. ModelActivity must call `Message.fromMessageData` so the
  // user's `Model.stream` receives real Strands types.
  t.timeout(60_000);
  const { createWorker, executeWorkflow } = helpers(t);

  // Capture what arrives at stream() so the assertion runs even though the
  // model lives on the worker — record into a module-level sink that's also
  // reachable from the assertion below.
  let receivedFirstMessage: unknown;
  let firstBlockIsTextBlock = false;
  class AssertingStub extends StubModel {
    override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
      if (receivedFirstMessage === undefined) {
        receivedFirstMessage = messages[0];
        const first = messages[0];
        firstBlockIsTextBlock = first instanceof Message && first.content[0] instanceof TextBlock;
      }
      yield* super.stream(messages, options);
    }
  }

  const worker = await createWorker({
    plugins: [
      new StrandsPlugin({
        models: { test: () => new AssertingStub([textTurn('ok')]) },
      }),
    ],
  });

  await worker.runUntil(async () => {
    await executeWorkflow(helloAgent, { args: ['say hi'] });
  });

  t.true(receivedFirstMessage instanceof Message, 'expected first message to be a Message instance');
  t.true(firstBlockIsTextBlock, 'expected first content block to be a TextBlock instance');
});

test('activityAsTool dispatches a registered activity from the agent loop', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new StrandsPlugin({
        models: {
          test: () =>
            new StubModel([
              toolCallTurn('getWeather', 'call_1', { location: 'Tokyo' }),
              textTurn('the weather is sunny'),
            ]),
        },
      }),
    ],
    activities: { getWeather },
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(activityToolAgent, { args: ['weather in Tokyo?'] });
    t.is(result, 'the weather is sunny');
  });

  // Assert the activity was actually invoked with the model's tool input — this
  // would fail if the plugin returned the scripted reply without dispatching it.
  // `getWeatherCalls` is a process-wide sink shared with other tests that ava may
  // run concurrently, so filter to this test's unique location ('Tokyo'); no
  // other test invokes getWeather with it.
  t.deepEqual(
    getWeatherCalls.filter((c) => c.location === 'Tokyo'),
    [{ location: 'Tokyo' }]
  );
});

test('TemporalMCPClient lists and calls tools through per-server activities', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  // Record the args the MCP client's callTool was actually invoked with, so the
  // assertion proves the per-server callTool activity ran rather than relying on
  // the stub model's scripted reply.
  const callToolArgs: Array<{ name: string; args: JSONValue }> = [];
  class CapturingMcpClient extends StubMcpClient {
    override async callTool(tool: { name: string }, args: JSONValue): Promise<JSONValue> {
      callToolArgs.push({ name: tool.name, args });
      return super.callTool(tool, args);
    }
  }
  const factory = (): McpClient =>
    new CapturingMcpClient([
      {
        name: 'listFiles',
        description: 'List files',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);

  const worker = await createWorker({
    plugins: [
      new StrandsPlugin({
        models: {
          test: () => new StubModel([toolCallTurn('listFiles', 'call_1', { path: '/' }), textTurn('found files')]),
        },
        mcpClients: { testServer: factory },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(mcpAgent, { args: ['list files'] });
    t.is(result, 'found files');
  });

  t.deepEqual(callToolArgs, [{ name: 'listFiles', args: { path: '/' } }]);
});

test('successive MCP tool calls reuse one cached worker-side connection', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const counters = { factoryCalls: 0, connects: 0, disconnects: 0, callTools: 0 };
  const callToolArgs: Array<{ name: string; args: JSONValue }> = [];
  class CountingMcpClient extends StubMcpClient {
    override async connect(): Promise<void> {
      counters.connects++;
    }
    override async disconnect(): Promise<void> {
      counters.disconnects++;
    }
    override async callTool(tool: { name: string }, args: JSONValue): Promise<JSONValue> {
      counters.callTools++;
      callToolArgs.push({ name: tool.name, args });
      return super.callTool(tool, args);
    }
  }
  const factory = (): McpClient => {
    counters.factoryCalls++;
    return new CountingMcpClient([
      { name: 'listFiles', description: 'List files', inputSchema: { type: 'object', properties: {} } },
    ]);
  };

  const worker = await createWorker({
    plugins: [
      new StrandsPlugin({
        models: {
          // Two tool-call turns in one workflow → two callTool activities.
          test: () =>
            new StubModel([
              toolCallTurn('listFiles', 'call_1', { path: '/a' }),
              toolCallTurn('listFiles', 'call_2', { path: '/b' }),
              textTurn('done'),
            ]),
        },
        // Distinct server name so the worker-process connection cache can't be
        // shared with the sibling MCP test running in the same process.
        mcpClients: { cachingServer: factory },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(mcpAgent, { args: ['list files', 'cachingServer'] });
    t.is(result, 'done');
    // The initial listTools opens one connection that both tool calls then
    // reuse — a single factory/connect for the whole workflow. (No caching
    // would mean factoryCalls/connects === 3: listTools plus each call.)
    t.is(counters.callTools, 2);
    t.is(counters.factoryCalls, 1);
    t.is(counters.connects, 1);
    // The cached connection stays open mid-run; nothing has disconnected yet.
    t.is(counters.disconnects, 0);
    // Both tool calls reached the client with the model's scripted inputs.
    t.deepEqual(callToolArgs, [
      { name: 'listFiles', args: { path: '/a' } },
      { name: 'listFiles', args: { path: '/b' } },
    ]);
  });

  // Worker shutdown evicts the cached connection.
  t.is(counters.disconnects, 1);
});

test('mcpConnectionIdleTimeout evicts the cached connection while the worker runs', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const counters = { disconnects: 0 };
  class CountingMcpClient extends StubMcpClient {
    override async disconnect(): Promise<void> {
      counters.disconnects++;
    }
  }
  const factory = (): McpClient =>
    new CountingMcpClient([
      { name: 'listFiles', description: 'List files', inputSchema: { type: 'object', properties: {} } },
    ]);

  const worker = await createWorker({
    plugins: [
      new StrandsPlugin({
        models: {
          test: () => new StubModel([toolCallTurn('listFiles', 'call_1', { path: '/' }), textTurn('done')]),
        },
        // Distinct server name so the worker-process connection cache can't be
        // shared with the sibling MCP tests running in the same process.
        mcpClients: { idleServer: factory },
        // Short idle window (duration string form) so the cached call connection
        // is evicted mid-run rather than only at worker shutdown.
        mcpConnectionIdleTimeout: '100ms',
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(mcpAgent, { args: ['list files', 'idleServer'] });
    t.is(result, 'done');
    // Wait past the short idle window: the cached connection should be
    // disconnected by the idle timer on its own. Observing a disconnect inside
    // runUntil (worker still alive) proves the eviction came from the timer, not
    // worker shutdown — with the default 5-minute window nothing would have
    // disconnected here. (The exact connect/disconnect counts aren't asserted:
    // the timer may also fire between the listTools and callTool activities,
    // forcing a reconnect, which is itself valid idle-eviction behavior.)
    await new Promise((resolve) => setTimeout(resolve, 1000));
    t.true(counters.disconnects >= 1, 'expected the idle timer to evict the connection mid-run');
  });
});

test('in-workflow tool() runs inside the workflow sandbox', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  // Capture the follow-up model call's messages: the tool's result carries an
  // `echoed:` marker the stub model never emits, so seeing it proves the
  // callback actually ran (not just that the scripted reply was returned).
  let secondCallMessages: Message[] | undefined;
  class CapturingStub extends StubModel {
    private call = 0;
    override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
      if (this.call++ === 1) secondCallMessages = messages;
      yield* super.stream(messages, options);
    }
  }

  const worker = await createWorker({
    plugins: [
      new StrandsPlugin({
        models: {
          test: () =>
            new CapturingStub([
              toolCallTurn('echo', 'call_1', { text: 'hi from in-workflow tool' }),
              textTurn('echoed'),
            ]),
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(inWorkflowToolAgent, { args: ['say hi'] });
    t.is(result, 'echoed');
  });

  t.true(JSON.stringify(secondCallMessages).includes('echoed: hi from in-workflow tool'));
});

test('activityAsHook dispatches a registered activity on AfterToolCallEvent', async (t) => {
  auditLog.length = 0;
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new StrandsPlugin({
        models: {
          test: () => new StubModel([toolCallTurn('echo', 'call_1', { text: 'hello' }), textTurn('done')]),
        },
      }),
    ],
    activities: { auditTool },
  });

  await worker.runUntil(async () => {
    const fired = await executeWorkflow(hooksAgent, { args: ['say hello'] });
    t.deepEqual(fired, ['echo']);
  });
  t.deepEqual(auditLog, ['echo']);
});

test('TemporalAgent surfaces structured output via structuredOutputSchema', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const person = { name: 'John Smith', age: 30, occupation: 'software engineer' };
  const worker = await createWorker({
    plugins: [
      new StrandsPlugin({
        models: {
          // Strands' structured-output flow exposes a fixed tool named
          // `strands_structured_output`; the model's tool-call turn carries the
          // validated object as the tool input.
          test: () => new StubModel([toolCallTurn('strands_structured_output', 'call_1', person)]),
        },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(structuredOutputAgent, { args: ['describe John'] });
    t.deepEqual(result, person);
  });
});

test('activity-tool interrupt round-trips through failure converter and resume', async (t) => {
  deleteState.calls = 0;
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new StrandsPlugin({
        models: {
          test: () => new StubModel([toolCallTurn('deleteThing', 'call_1', { name: 'foo' }), textTurn('done')]),
        },
      }),
    ],
    activities: { deleteThing },
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(interruptAgent, {
      args: ['delete foo'],
      workflowExecutionTimeout: '30 seconds',
    });
    await handle.signal(approveSignal, 'approve');
    t.is(await handle.result(), 'done');
  });
  // First activity invocation threw the interrupt; second succeeded after resume.
  t.is(deleteState.calls, 2);
});

test('streamingTopic publishes model events to a WorkflowStream subscriber', async (t) => {
  const { createWorker, startWorkflow, taskQueue } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new StrandsPlugin({
        models: { test: () => new StubModel([textTurn('streamed')]) },
      }),
    ],
  });

  await worker.runUntil(async () => {
    const handle = await startWorkflow(streamingAgent, {
      args: ['say something'],
      workflowExecutionTimeout: '30 seconds',
    });

    const stream = WorkflowStreamClient.create(t.context.env.client, handle.workflowId);
    const events: Array<{ type?: string }> = [];
    const subscriber = (async () => {
      // textTurn yields 5 model events (messageStart, contentBlockStart,
      // contentBlockDelta, contentBlockStop, messageStop); break once we've
      // observed the terminal `modelMessageStopEvent`.
      for await (const item of stream.subscribe<{ type?: string }>(['model'], 0, {
        pollCooldown: '50 milliseconds',
        resultType: true,
      })) {
        events.push(item.data);
        if (item.data.type === 'modelMessageStopEvent') break;
      }
    })();

    t.is(await handle.result(), 'streamed');
    await subscriber;
    t.true(
      events.some((e) => e.type === 'modelMessageStartEvent'),
      'expected a modelMessageStartEvent in the stream'
    );
    t.true(
      events.some((e) => e.type === 'modelMessageStopEvent'),
      'expected a modelMessageStopEvent in the stream'
    );
  });
  // Reference `taskQueue` to keep the helper destructure from being flagged as unused.
  t.truthy(taskQueue);
});

test('captured history replays deterministically', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const plugin = (): StrandsPlugin =>
    new StrandsPlugin({
      models: {
        test: () =>
          new StubModel([
            toolCallTurn('getWeather', 'call_1', { location: 'Kyoto' }),
            textTurn('the weather is sunny'),
          ]),
      },
    });

  const worker = await createWorker({ plugins: [plugin()], activities: { getWeather } });

  let history;
  await worker.runUntil(async () => {
    const handle = await startWorkflow(activityToolAgent, {
      args: ['weather in Tokyo?'],
      workflowExecutionTimeout: '30 seconds',
    });
    t.is(await handle.result(), 'the weather is sunny');
    history = await handle.fetchHistory();
  });

  // Replay the captured history with a fresh plugin instance. Any non-determinism
  // (e.g. a polyfill that read system state) would surface as DeterminismViolationError.
  await Worker.runReplayHistory(
    {
      workflowBundle: t.context.workflowBundle,
      plugins: [plugin()],
    },
    history!
  );
});
