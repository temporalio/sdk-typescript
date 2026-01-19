import type { WorkflowInterceptors } from '@temporalio/workflow';
import { OpenTelemetryInboundInterceptor, OpenTelemetryOutboundInterceptor } from '../workflow';

export const interceptors = (): WorkflowInterceptors => ({
  inbound: [new OpenTelemetryInboundInterceptor()],
  outbound: [new OpenTelemetryOutboundInterceptor()],
});
