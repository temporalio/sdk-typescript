import type { WorkflowInterceptors } from '@temporalio/workflow';
import { OpenTelemetryInboundInterceptor } from '../workflow';

export const interceptors = (): WorkflowInterceptors => ({
  inbound: [new OpenTelemetryInboundInterceptor()],
});
