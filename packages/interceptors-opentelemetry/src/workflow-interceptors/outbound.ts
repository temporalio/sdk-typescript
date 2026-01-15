import type { WorkflowInterceptors } from '@temporalio/workflow';
import { OpenTelemetryOutboundInterceptor } from '../workflow';

export const interceptors = (): WorkflowInterceptors => ({
  outbound: [new OpenTelemetryOutboundInterceptor()],
});
