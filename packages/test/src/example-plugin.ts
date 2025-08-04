import { Plugin as ClientPlugin, ClientConfig } from '@temporalio/client';
import { Plugin as WorkerPlugin, WorkerConfig } from '@temporalio/worker';

/**
 * Example plugin that demonstrates how to extend both client and worker functionality.
 * 
 * This plugin:
 * 1. Adds custom metadata to client connections
 * 2. Modifies worker task queue names 
 * 3. Adds logging functionality
 * 4. Demonstrates the chain of responsibility pattern
 */
export class ExamplePlugin extends WorkerPlugin {
  private readonly customMetadata: Record<string, string>;
  private readonly taskQueuePrefix: string;

  constructor(options: { metadata?: Record<string, string>; taskQueuePrefix?: string } = {}) {
    super();
    this.customMetadata = options.metadata ?? { 'x-custom-plugin': 'example-plugin' };
    this.taskQueuePrefix = options.taskQueuePrefix ?? 'plugin-';
  }

  /**
   * Configure client with custom metadata and logging
   */
  configureClient(config: ClientConfig): ClientConfig {
    console.log('ExamplePlugin: Configuring client');
    
    // Add custom metadata to connection if it exists
    if (config.connection && typeof config.connection === 'object') {
      // Note: In a real implementation, you would properly extend the connection
      // This is just for demonstration
      console.log('ExamplePlugin: Adding custom metadata to client connection');
    }

    // Add any custom client interceptors
    const interceptors = config.interceptors || {};
    
    const modifiedConfig = {
      ...config,
      interceptors,
      // Add any other client-specific configuration
    };

    // Chain to next plugin
    return super.configureClient(modifiedConfig);
  }

  /**
   * Configure worker with custom task queue and additional settings
   */
  configureWorker(config: WorkerConfig): WorkerConfig {
    console.log('ExamplePlugin: Configuring worker');
    
    // Modify task queue name with prefix
    const taskQueue = config.taskQueue ? `${this.taskQueuePrefix}${config.taskQueue}` : config.taskQueue;
    
    const modifiedConfig = {
      ...config,
      taskQueue,
      // Add any custom worker configuration
      identity: config.identity ? `${config.identity}-with-plugin` : config.identity,
    };

    console.log(`ExamplePlugin: Modified task queue to: ${taskQueue}`);

    // Chain to next plugin
    return super.configureWorker(modifiedConfig);
  }
}

/**
 * Another example plugin that demonstrates plugin chaining
 */
export class LoggingPlugin extends WorkerPlugin {
  configureClient(config: ClientConfig): ClientConfig {
    console.log('LoggingPlugin: Client configuration intercepted');
    console.log('LoggingPlugin: Client namespace:', config.namespace);
    
    return super.configureClient(config);
  }

  configureWorker(config: WorkerConfig): WorkerConfig {
    console.log('LoggingPlugin: Worker configuration intercepted');
    console.log('LoggingPlugin: Worker task queue:', config.taskQueue);
    console.log('LoggingPlugin: Worker namespace:', config.namespace);
    
    return super.configureWorker(config);
  }
}

/**
 * Example of how to use plugins with a client
 */
export async function exampleClientUsage() {
  const { Client } = await import('@temporalio/client');
  
  const client = new Client({
    plugins: [
      new ExamplePlugin({ 
        metadata: { 'x-environment': 'development' },
        taskQueuePrefix: 'dev-'
      }),
      new LoggingPlugin(),
    ],
    namespace: 'default',
  });

  console.log('Client created with plugins');
  return client;
}

/**
 * Example of how to use plugins with a worker
 */
export async function exampleWorkerUsage() {
  const { Worker } = await import('@temporalio/worker');
  
  const worker = await Worker.create({
    plugins: [
      new ExamplePlugin({ 
        taskQueuePrefix: 'production-'
      }),
      new LoggingPlugin(),
    ],
    taskQueue: 'my-task-queue',
    namespace: 'default',
    workflowsPath: require.resolve('./workflows'),
  });

  console.log('Worker created with plugins');
  return worker;
}

/**
 * Example plugin that could add custom activities
 */
export class ActivityPlugin extends WorkerPlugin {
  private activities: Record<string, Function>;

  constructor(activities: Record<string, Function>) {
    super();
    this.activities = activities;
  }

  configureWorker(config: WorkerConfig): WorkerConfig {
    console.log('ActivityPlugin: Adding custom activities');
    
    // Merge custom activities with existing ones
    const existingActivities = config.activities || {};
    const mergedActivities = {
      ...existingActivities,
      ...this.activities,
    };

    const modifiedConfig = {
      ...config,
      activities: mergedActivities,
    };

    return super.configureWorker(modifiedConfig);
  }
}

// Example activities to be added by the plugin
export const customActivities = {
  async logMessage(message: string): Promise<void> {
    console.log(`Custom activity: ${message}`);
  },
  
  async processData(data: any): Promise<any> {
    console.log('Custom activity: Processing data', data);
    return { processed: true, data };
  },
}; 