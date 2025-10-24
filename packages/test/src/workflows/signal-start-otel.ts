import * as workflow from '@temporalio/workflow';
import {
  OpenTelemetryInboundInterceptor,
  OpenTelemetryOutboundInterceptor,
  OpenTelemetryInternalsInterceptor,
} from '@temporalio/interceptors-opentelemetry/lib/workflow';

export const startSignal = workflow.defineSignal('startSignal');

const { a, b, c } = workflow.proxyLocalActivities({
  scheduleToCloseTimeout: '1m',
});

export async function signalStartOtel(): Promise<string> {
  const order = [];
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
