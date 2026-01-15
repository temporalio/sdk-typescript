import type { WorkflowInterceptors } from '@temporalio/workflow';
import { OpenTelemetryInboundInterceptor, OpenTelemetryInternalsInterceptor } from '../workflow';

export const interceptors = (): WorkflowInterceptors => ({
  inbound: [new OpenTelemetryInboundInterceptor()],
  internals: [new OpenTelemetryInternalsInterceptor()],
});
