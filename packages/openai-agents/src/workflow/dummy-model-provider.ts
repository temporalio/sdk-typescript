import type { Model, ModelProvider, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents-core';

/**
 * A Model that throws if called. Used as a safety net — all model resolution
 * should go through ActivityBackedModel, so DummyModel should never be invoked.
 */
class DummyModel implements Model {
  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error(
      'DummyModel.getResponse should never be called. ' +
        'All model calls should go through ActivityBackedModel via activities. ' +
        'If you see this error, an agent has a model that was not replaced by convertAgent().'
    );
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error('Streaming is not supported in Temporal workflows.');
  }
}

/**
 * A ModelProvider that returns DummyModel instances. Passed to the internal Runner
 * in workflow context to prevent real model providers (e.g. OpenAIProvider) from
 * being imported into the workflow sandbox.
 */
export class DummyModelProvider implements ModelProvider {
  getModel(_modelName?: string): Model {
    return new DummyModel();
  }
}
