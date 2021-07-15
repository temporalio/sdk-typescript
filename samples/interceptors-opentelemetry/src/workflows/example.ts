import { WorkflowInterceptors } from '@temporalio/workflow';
import {
  OpenTelemetryInboundInterceptor,
  OpenTelemetryOutboundInterceptor,
  registerOpentelemetryTracerProvider,
} from '@temporalio/interceptors-opentelemetry/lib/workflow';
import { Example } from '../interfaces/workflows';
import { greet } from '@activities/greeter';

// A workflow that simply calls an activity
async function main(name: string): Promise<string> {
  return greet(name);
}

// Declare the workflow's type to be checked by the Typescript compiler
export const workflow: Example = { main };

export const interceptors: WorkflowInterceptors = {
  inbound: [new OpenTelemetryInboundInterceptor()],
  outbound: [new OpenTelemetryOutboundInterceptor()],
};

registerOpentelemetryTracerProvider();
