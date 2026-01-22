import * as workflow from '@temporalio/workflow';
import {
  OpenTelemetryInboundInterceptor,
  OpenTelemetryOutboundInterceptor,
  OpenTelemetryInternalsInterceptor,
} from '../../workflow';

export const startSignal = workflow.defineSignal('startSignal');

interface LocalActivities {
  a(): Promise<string>;
  b(): Promise<string>;
  c(): Promise<string>;
}

const { a, b, c } = workflow.proxyLocalActivities<LocalActivities>({
  scheduleToCloseTimeout: '1m',
});

export async function signalStartOtel(): Promise<string> {
  const order: string[] = [];
  order.push(await a());
  workflow.setHandler(startSignal, async () => {
    order.push(await b());
  });
  order.push(await c());

  return order.join('');
}

export const interceptors = (): workflow.WorkflowInterceptors => ({
  inbound: [new OpenTelemetryInboundInterceptor()],
  outbound: [new OpenTelemetryOutboundInterceptor()],
  internals: [new OpenTelemetryInternalsInterceptor()],
});
