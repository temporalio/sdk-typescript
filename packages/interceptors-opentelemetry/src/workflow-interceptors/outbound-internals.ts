import type { WorkflowInterceptors } from '@temporalio/workflow';
import { OpenTelemetryOutboundInterceptor, OpenTelemetryInternalsInterceptor } from '../workflow';

export const interceptors = (): WorkflowInterceptors => ({
  outbound: [new OpenTelemetryOutboundInterceptor()],
  internals: [new OpenTelemetryInternalsInterceptor()],
});
