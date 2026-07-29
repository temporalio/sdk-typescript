import { Message } from '@strands-agents/sdk';
import type { Model, ModelStreamEvent, StreamOptions } from '@strands-agents/sdk';
import { WorkflowStreamClient } from '@temporalio/workflow-streams/client';
import type { Duration } from '@temporalio/common/lib/time';
import { autoHeartbeat } from './heartbeat';

/**
 * Reconstruct Strands `Message` instances from the wire data the workflow
 * payload converter delivered.
 *
 * Strands content-block and `Message` classes override `toJSON()` to project
 * themselves into Bedrock-style wire data (e.g. `TextBlock` → `{ text }`,
 * `ToolUseBlock` → `{ toolUse: {...} }`). Temporal's default payload
 * converter serializes activity input via `JSON.stringify`, which calls
 * those `toJSON`s, dropping the `type` discriminator and reshaping every
 * block. The receiving side sees plain Bedrock-shape objects that don't
 * match what `BedrockModel._formatContentBlock` (or any other Strands
 * `Model.stream` implementation) expects.
 *
 * `Message.fromMessageData` knows how to rebuild a `Message` and its blocks
 * from that wire shape via `contentBlockFromData`, so call it once on every
 * incoming message before handing them to the user-supplied `Model`.
 */
function rebuildMessages(messages: unknown): Message[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.map((m) =>
    m instanceof Message ? m : Message.fromMessageData(m as Parameters<typeof Message.fromMessageData>[0])
  );
}

/**
 * Input for the `invokeModel` activity. Mirrors `Model.stream(messages, options)`
 * with the chosen factory name carried alongside.
 */
export interface InvokeModelInput {
  modelName?: string;
  messages: Message[];
  options?: StreamOptions;
}

/**
 * Input for the `invokeModelStreaming` activity. Adds the workflow-stream topic
 * to which each event is published, and the batch interval for publishes.
 */
export interface InvokeModelStreamingInput extends InvokeModelInput {
  streamingTopic: string;
  streamingBatchInterval: Duration;
}

/**
 * Holds the model factory map and exposes the model activities.
 *
 * Models are constructed lazily on first use and cached for the worker's
 * lifetime. `defaultName` is only set by the plugin's own implicit
 * default-Bedrock fallback; user-supplied factories force `model: 'name'`
 * on every {@link TemporalAgent}.
 *
 * Both activities heartbeat at half the configured `heartbeatTimeout` via
 * {@link autoHeartbeat} so long model calls don't stall the worker's view
 * of activity liveness.
 */
export class ModelActivity {
  private readonly models: Map<string, Model> = new Map();

  constructor(
    private readonly factories: Record<string, () => Model>,
    private readonly defaultName?: string
  ) {
    this.invokeModel = autoHeartbeat(this.invokeModel.bind(this));
    this.invokeModelStreaming = autoHeartbeat(this.invokeModelStreaming.bind(this));
  }

  private getModel(name?: string): Model {
    const resolved = name ?? this.defaultName;
    if (resolved === undefined) {
      throw new Error(
        `TemporalAgent was constructed without an explicit \`model\`, but the plugin was configured ` +
          `with user-supplied \`models\`. Pass model='...' to TemporalAgent. ` +
          `Known: ${Object.keys(this.factories).sort().join(', ')}`
      );
    }
    let model = this.models.get(resolved);
    if (model === undefined) {
      const factory = this.factories[resolved];
      if (factory === undefined) {
        throw new Error(`Unknown model name '${resolved}'. Known: ${Object.keys(this.factories).sort().join(', ')}`);
      }
      model = factory();
      this.models.set(resolved, model);
    }
    return model;
  }

  async invokeModel(input: InvokeModelInput): Promise<ModelStreamEvent[]> {
    const model = this.getModel(input.modelName);
    const messages = rebuildMessages(input.messages);
    const events: ModelStreamEvent[] = [];
    for await (const event of model.stream(messages, input.options)) {
      events.push(event);
    }
    return events;
  }

  async invokeModelStreaming(input: InvokeModelStreamingInput): Promise<ModelStreamEvent[]> {
    const model = this.getModel(input.modelName);
    const messages = rebuildMessages(input.messages);
    const stream = WorkflowStreamClient.fromWithinActivity({
      batchInterval: input.streamingBatchInterval,
    });
    const topic = stream.topic(input.streamingTopic);
    const events: ModelStreamEvent[] = [];
    try {
      for await (const event of model.stream(messages, input.options)) {
        events.push(event);
        topic.publish(event);
      }
    } finally {
      await stream[Symbol.asyncDispose]();
    }
    return events;
  }
}
