# @temporalio/ai-sdk

Seamless integration between Temporal workflows and the Vercel AI SDK, enabling AI model calls within Temporal workflows while maintaining deterministic execution.

## Features

- 🔄 **Deterministic AI**: Execute AI model calls within Temporal workflows through activities
- 🎯 **Type Safe**: Full TypeScript support with preserved AI SDK interfaces
- 🚀 **Multi-Provider**: Works with OpenAI, Anthropic, Google, and other AI SDK providers
- ⚡ **Zero Configuration**: Drop-in replacement for standard AI SDK functions
- 🛡️ **Error Handling**: Built-in retry policies and error recovery
- 📊 **Observability**: Full integration with Temporal's monitoring and logging

## Installation

```bash
npm install @temporalio/ai-sdk ai
```

Note: You'll also need to install your preferred AI provider package (e.g., `ai/openai`, `ai/anthropic`).

## Quick Start

### 1. Set up your worker with AI activities

```typescript
// worker.ts
import { Worker } from '@temporalio/worker';
import * as aiActivities from '@temporalio/ai-sdk/activities';

const worker = await Worker.create({
  workflowsPath: require.resolve('./workflows'),
  activities: {
    ...aiActivities,
  },
  taskQueue: 'ai-workflows',
});
```

### 2. Use AI models in your workflows

```typescript
// workflows.ts
import { createTemporalAI, generateText } from '@temporalio/ai-sdk';
import { openai } from 'ai/openai';

export async function contentGenerationWorkflow(topic: string): Promise<string> {
  // Create a Temporal-compatible AI model
  const ai = createTemporalAI(openai('gpt-4'));
  
  // Use it just like the regular AI SDK
  const result = await generateText({
    model: ai,
    prompt: `Write about ${topic}`,
    maxTokens: 500,
  });
  
  return result.text;
}
```

### 3. Run your workflow

```typescript
// client.ts
import { Client } from '@temporalio/client';

const client = new Client();
const handle = await client.workflow.start(contentGenerationWorkflow, {
  args: ['artificial intelligence'],
  taskQueue: 'ai-workflows',
  workflowId: 'content-gen-1',
});

const result = await handle.result();
console.log(result); // Generated content about AI
```

## API Reference

### `createTemporalAI(model, options?)`

Wraps any AI SDK model to work within Temporal workflows.

```typescript
import { createTemporalAI } from '@temporalio/ai-sdk';
import { openai } from 'ai/openai';

const ai = createTemporalAI(openai('gpt-4'), {
  activityOptions: {
    startToCloseTimeout: '10 minutes',
    retryPolicy: {
      maximumAttempts: 3,
    },
  },
});
```

### `generateText(params)`

Temporal-compatible version of AI SDK's `generateText`.

```typescript
import { generateText } from '@temporalio/ai-sdk';

const result = await generateText({
  model: ai,
  prompt: 'Hello, world!',
  maxTokens: 100,
});
```

### `generateObject(params)`

Temporal-compatible version of AI SDK's `generateObject`.

```typescript
import { generateObject } from '@temporalio/ai-sdk';
import { z } from 'zod';

const result = await generateObject({
  model: ai,
  schema: z.object({
    title: z.string(),
    summary: z.string(),
  }),
  prompt: 'Extract information from this text...',
});
```

## Supported Providers

All AI SDK providers are supported:

- **OpenAI**: `openai('gpt-4')`, `openai('gpt-3.5-turbo')`
- **Anthropic**: `anthropic('claude-3-sonnet')`, `anthropic('claude-3-haiku')`
- **Google**: `google('gemini-pro')`, `google('gemini-pro-vision')`
- **Custom providers**: Any provider that implements the AI SDK interface

## Configuration Options

### TemporalAIOptions

```typescript
interface TemporalAIOptions {
  /** Activity options for AI model execution */
  activityOptions?: ActivityOptions;
  /** Enable response caching (future feature) */
  caching?: boolean;
}
```

### Activity Options

You can customize how AI model calls are executed:

```typescript
const ai = createTemporalAI(openai('gpt-4'), {
  activityOptions: {
    startToCloseTimeout: '15 minutes', // Longer timeout for complex tasks
    retryPolicy: {
      maximumAttempts: 5,
      initialInterval: '2s',
      backoffCoefficient: 2,
    },
  },
});
```

## Examples

### Structured Data Extraction

```typescript
import { generateObject } from '@temporalio/ai-sdk';
import { z } from 'zod';

export async function extractContactInfo(email: string) {
  const ai = createTemporalAI(openai('gpt-4'));
  
  const contactSchema = z.object({
    name: z.string(),
    company: z.string().optional(),
    phone: z.string().optional(),
    topics: z.array(z.string()),
  });
  
  const result = await generateObject({
    model: ai,
    schema: contactSchema,
    prompt: `Extract contact information from this email: ${email}`,
  });
  
  return result.object;
}
```

### Multi-Step AI Workflow

```typescript
export async function documentReviewWorkflow(document: string) {
  const ai = createTemporalAI(openai('gpt-4'));
  
  // Step 1: Analyze the document
  const analysis = await generateObject({
    model: ai,
    schema: analysisSchema,
    prompt: `Analyze this document: ${document}`,
  });
  
  // Step 2: Generate improvements based on analysis
  if (analysis.object.needsImprovement) {
    const improvements = await generateText({
      model: ai,
      prompt: `Suggest improvements for: ${document}`,
    });
    
    return { analysis: analysis.object, improvements: improvements.text };
  }
  
  return { analysis: analysis.object, improvements: null };
}
```

### Error Handling and Fallbacks

```typescript
export async function robustContentWorkflow(prompt: string) {
  try {
    // Try with GPT-4 first
    const ai = createTemporalAI(openai('gpt-4'));
    return await generateText({ model: ai, prompt });
  } catch (error) {
    // Fallback to GPT-3.5 if GPT-4 fails
    const fallbackAI = createTemporalAI(openai('gpt-3.5-turbo'));
    return await generateText({ model: fallbackAI, prompt });
  }
}
```

## Best Practices

1. **Timeout Configuration**: Set appropriate timeouts based on your model and task complexity
2. **Retry Policies**: Configure retries for transient failures like rate limits
3. **Model Selection**: Choose the right model for your use case (speed vs. quality)
4. **Error Handling**: Always have fallback strategies for AI failures
5. **Cost Management**: Monitor usage and set appropriate limits

## Troubleshooting

### Common Issues

**Activity timeout errors**: Increase `startToCloseTimeout` for complex AI tasks:

```typescript
const ai = createTemporalAI(model, {
  activityOptions: {
    startToCloseTimeout: '20 minutes',
  },
});
```

**Rate limit errors**: Configure retry policies with exponential backoff:

```typescript
const ai = createTemporalAI(model, {
  activityOptions: {
    retryPolicy: {
      maximumAttempts: 5,
      initialInterval: '5s',
      backoffCoefficient: 2,
      maximumInterval: '60s',
    },
  },
});
```

## Contributing

We welcome contributions! Please see our [Contributing Guide](../../CONTRIBUTING.md) for details.

## License

MIT © Temporal Technologies Inc.