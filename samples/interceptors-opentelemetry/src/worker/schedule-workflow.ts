import { Connection, WorkflowClient } from '@temporalio/client';
import { OpenTelemetryWorkflowClientCallsInterceptor } from '@temporalio/interceptors-opentelemetry/lib/client';
import { Example } from '../interfaces/workflows';
import { setupOpentelemetry } from './setup';

async function run() {
  const otel = await setupOpentelemetry();
  // Connect to localhost with default ConnectionOptions,
  // pass options to the Connection constructor to configure TLS and other settings.
  const connection = new Connection({});
  // Attach the OpenTelemetryWorkflowClientCallsInterceptor to the client.
  const client = new WorkflowClient(connection.service, {
    interceptors: {
      calls: [() => new OpenTelemetryWorkflowClientCallsInterceptor()],
    },
  });
  // Create a typed client using the Example Workflow interface,
  // Workflow will be started in the "default" namespace unless specified otherwise.
  const example = client.stub<Example>('example', {
    taskQueue: 'interceptors-opentelemetry-example',
  });
  const result = await example.execute('Temporal');
  console.log(result); // Hello, Temporal!
  await otel.sdk.shutdown();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
