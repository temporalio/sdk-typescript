import { Model, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents';
import * as workflow from '@temporalio/workflow'

export class TemporalModel implements Model {
  constructor(private readonly modelName: string) {
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
      return await workflow.proxyActivities({startToCloseTimeout: '10 minutes'}).invokeModel!(this.modelName, request);
  }

  getStreamedResponse(_: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error('Streaming not implemented.');
  }
}