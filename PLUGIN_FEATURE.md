# Temporal TypeScript SDK Plugin Support

This implements a Plugin system similar to the Python SDK's Plugin feature, allowing you to extend and customize the behavior of Temporal clients and workers through a chain of responsibility pattern.

## Overview

Plugins provide a way to intercept and modify:
- Client creation and configuration
- Service connections  
- Worker configuration and execution
- Activities, workflows, and interceptors

## Architecture

The plugin system uses a **chain of responsibility pattern** where each plugin can:
1. Modify configuration
2. Pass control to the next plugin in the chain
3. Perform custom logic before/after delegation

## Client Plugin Support

### ClientOptions Extension

```typescript
export interface ClientOptions extends BaseClientOptions {
  // ... existing options ...
  
  /**
   * List of plugins to register with the client.
   */
  plugins?: Plugin[];
}
```

### Plugin Base Class

```typescript
export abstract class Plugin {
  /**
   * Gets the fully qualified name of this plugin.
   */
  get name(): string;

  /**
   * Initialize this plugin in the plugin chain.
   */
  initClientPlugin(next: Plugin): Plugin;

  /**
   * Hook called when creating a client to allow modification of configuration.
   */
  configureClient(config: ClientConfig): ClientConfig;

  /**
   * Hook called when connecting to the Temporal service.
   */
  async connectServiceClient(config: ConnectionOptions): Promise<ConnectionLike>;
}
```

## Worker Plugin Support

### WorkerOptions Extension

```typescript
export interface WorkerOptions {
  // ... existing options ...
  
  /**
   * List of plugins to register with the worker.
   */
  plugins?: Plugin[];
}
```

### Worker Plugin Methods

```typescript
export abstract class Plugin extends ClientPlugin {
  /**
   * Initialize this plugin in the worker plugin chain.
   */
  initWorkerPlugin(next: Plugin): Plugin;

  /**
   * Hook called when creating a worker to allow modification of configuration.
   */
  configureWorker(config: WorkerConfig): WorkerConfig;
}
```

## Usage Examples

### Basic Client Plugin

```typescript
import { Plugin, Client } from '@temporalio/client';

class CustomClientPlugin extends Plugin {
  configureClient(config: ClientConfig): ClientConfig {
    // Add custom metadata
    console.log('Configuring client with custom settings');
    
    // Modify configuration
    const modifiedConfig = {
      ...config,
      // Add custom properties
    };
    
    // Chain to next plugin
    return super.configureClient(modifiedConfig);
  }
}

// Use with client
const client = new Client({
  plugins: [new CustomClientPlugin()],
  namespace: 'default',
});
```

### Basic Worker Plugin

```typescript
import { Plugin, Worker } from '@temporalio/worker';

class CustomWorkerPlugin extends Plugin {
  configureWorker(config: WorkerConfig): WorkerConfig {
    // Modify task queue name
    const taskQueue = config.taskQueue ? `custom-${config.taskQueue}` : config.taskQueue;
    
    const modifiedConfig = {
      ...config,
      taskQueue,
      identity: `${config.identity}-with-plugin`,
    };
    
    console.log(`Modified task queue to: ${taskQueue}`);
    return super.configureWorker(modifiedConfig);
  }
}

// Use with worker
const worker = await Worker.create({
  plugins: [new CustomWorkerPlugin()],
  taskQueue: 'my-task-queue',
  workflowsPath: './workflows',
});
```

### Activity Plugin Example

```typescript
class ActivityPlugin extends Plugin {
  private activities: Record<string, Function>;

  constructor(activities: Record<string, Function>) {
    super();
    this.activities = activities;
  }

  configureWorker(config: WorkerConfig): WorkerConfig {
    // Merge custom activities with existing ones
    const existingActivities = config.activities || {};
    const mergedActivities = {
      ...existingActivities,
      ...this.activities,
    };

    return super.configureWorker({
      ...config,
      activities: mergedActivities,
    });
  }
}

// Custom activities
const customActivities = {
  async logMessage(message: string): Promise<void> {
    console.log(`Custom activity: ${message}`);
  },
  
  async processData(data: any): Promise<any> {
    return { processed: true, data };
  },
};

// Use the plugin
const worker = await Worker.create({
  plugins: [new ActivityPlugin(customActivities)],
  taskQueue: 'my-task-queue',
  workflowsPath: './workflows',
});
```

### Multiple Plugin Chain

```typescript
class LoggingPlugin extends Plugin {
  configureClient(config: ClientConfig): ClientConfig {
    console.log('LoggingPlugin: Client configuration');
    return super.configureClient(config);
  }

  configureWorker(config: WorkerConfig): WorkerConfig {
    console.log('LoggingPlugin: Worker configuration');
    return super.configureWorker(config);
  }
}

class MetricsPlugin extends Plugin {
  configureClient(config: ClientConfig): ClientConfig {
    console.log('MetricsPlugin: Adding metrics interceptors');
    // Add metrics interceptors
    return super.configureClient(config);
  }
}

// Chain multiple plugins
const client = new Client({
  plugins: [
    new LoggingPlugin(),
    new MetricsPlugin(),
    new CustomClientPlugin(),
  ],
  namespace: 'default',
});
```

## Implementation Details

### Plugin Chain Building

The `buildPluginChain()` function creates a chain of responsibility:

```typescript
export function buildPluginChain(plugins: Plugin[]): Plugin {
  if (plugins.length === 0) {
    return new _RootPlugin();
  }

  // Start with the root plugin at the end
  let chain: Plugin = new _RootPlugin();
  
  // Build the chain in reverse order
  for (let i = plugins.length - 1; i >= 0; i--) {
    const plugin = plugins[i];
    plugin.initClientPlugin(chain);
    chain = plugin;
  }
  
  return chain;
}
```

### Client Integration

The Client constructor processes plugins before initialization:

```typescript
constructor(options?: ClientOptions) {
  // Process plugins first to allow them to modify configuration
  const processedOptions = Client.applyPlugins(options);
  
  super(processedOptions);
  // ... rest of constructor
}

private static applyPlugins(options?: ClientOptions): ClientOptions {
  if (!options?.plugins?.length) {
    return options ?? {};
  }

  const pluginChain = buildPluginChain(options.plugins);
  const clientConfig: ClientConfig = { ...options };
  const processedConfig = pluginChain.configureClient(clientConfig);
  
  return { ...processedConfig };
}
```

### Worker Integration

Similarly, the Worker.create() method would process plugins:

```typescript
public static async create(options: WorkerOptions): Promise<Worker> {
  // Apply plugins to modify configuration
  const processedOptions = Worker.applyPlugins(options);
  
  // ... rest of worker creation with processed options
}
```

## Files Modified/Added

### Client Package (`packages/client/`)
- **NEW**: `src/plugin.ts` - Base Plugin class and client plugin support
- **MODIFIED**: `src/client.ts` - Added plugins field to ClientOptions and plugin processing
- **MODIFIED**: `src/index.ts` - Export Plugin and related types

### Worker Package (`packages/worker/`)
- **NEW**: `src/plugin.ts` - Worker plugin extension and chain building
- **MODIFIED**: `src/worker-options.ts` - Added plugins field to WorkerOptions  
- **MODIFIED**: `src/index.ts` - Export worker Plugin and related types

### Test Package (`packages/test/`)
- **NEW**: `src/example-plugin.ts` - Comprehensive examples and usage patterns

## Benefits

1. **Extensibility**: Easily extend client and worker functionality without modifying core SDK
2. **Composability**: Chain multiple plugins together for complex customizations
3. **Consistency**: Similar pattern to Python SDK for cross-language familiarity
4. **Separation of Concerns**: Keep custom logic separate from core application code
5. **Reusability**: Plugins can be shared across projects and teams

## Common Use Cases

- **Authentication**: Add custom auth headers or credentials
- **Observability**: Inject custom metrics, logging, or tracing
- **Data Transformation**: Custom data converters or payload codecs
- **Environment Configuration**: Different settings per environment
- **Activity/Workflow Registration**: Dynamically add activities or workflows
- **Connection Customization**: Modify connection parameters or retry policies
- **Namespace Management**: Automatic namespace prefixing or routing

This plugin system provides a powerful, flexible way to customize Temporal SDK behavior while maintaining clean separation of concerns and enabling code reuse across projects. 