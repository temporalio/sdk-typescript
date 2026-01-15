import type { WorkflowInterceptors } from '@temporalio/workflow';
import { OpenTelemetryInternalsInterceptor } from '../workflow';

export const interceptors = (): WorkflowInterceptors => ({
  internals: [new OpenTelemetryInternalsInterceptor()],
});
