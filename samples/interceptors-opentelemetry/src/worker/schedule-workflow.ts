import { Connection } from '@temporalio/client';
import { OpenTelemetryWorkflowClientCallsInterceptor } from '@temporalio/interceptors-opentelemetry/lib/client';
import { Example } from '../interfaces/workflows';
import { setupOpentelemetry } from './setup';

async function run() {
  const otel = await setupOpentelemetry();

  // Connect to localhost and set up the opentelemetry WorkflowClient calls interceptor
  // pass options to the Connection constructor to configure TLS and other settings.
  const connection = new Connection({
    interceptors: {
      workflowClient: [(_options) => new OpenTelemetryWorkflowClientCallsInterceptor()],
    },
  });
  // Create a typed client using the Example Workflow interface,
  // Workflow will be started in the "default" namespace unless specified otherwise.
  const example = connection.workflow<Example>('example', {
    taskQueue: 'interceptors-opentelemetry-example',
  });
  const result = await example.start('Temporal');
  console.log(result); // Hello, Temporal!
  await otel.sdk.shutdown();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
