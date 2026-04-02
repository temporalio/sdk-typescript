import { sleep, uuid4 } from '@temporalio/workflow';

async function logWorkflowRandomAcrossActivation(): Promise<void> {
  console.log('workflow', Math.random());
  await sleep(1);
  console.log('workflow', Math.random());
}

async function logWorkflowUuidAcrossActivation(): Promise<void> {
  console.log('workflow-uuid', uuid4());
  await sleep(1);
  console.log('workflow-uuid', uuid4());
}

export async function randomStreamMainBaselineWithSleep(): Promise<void> {
  await logWorkflowRandomAcrossActivation();
}

export async function randomStreamUuidBaselineWithSleep(): Promise<void> {
  await logWorkflowUuidAcrossActivation();
}

export async function randomStreamPluginNamedStreamDoesNotConsumeMain(): Promise<void> {
  await logWorkflowRandomAcrossActivation();
}

export async function randomStreamPluginNamedStreamNamespaceBaseline(): Promise<void> {
  // Intentionally empty: plugin interceptor behavior is the test surface.
}

export async function randomStreamPluginNamedStreamNamespaceIsolation(): Promise<void> {
  // Intentionally empty: plugin interceptor behavior is the test surface.
}

export async function randomStreamPluginActivationBaseline(): Promise<void> {
  await sleep(1);
}

export async function randomStreamPluginActivationWithWorkflowInterference(): Promise<void> {
  await logWorkflowRandomAcrossActivation();
}

export async function randomStreamPluginScopedMathAroundNext(): Promise<void> {
  await logWorkflowRandomAcrossActivation();
}

export async function randomStreamPluginScopedUuidAroundNext(): Promise<void> {
  await logWorkflowUuidAcrossActivation();
}

export async function randomStreamPluginOutboundTimerNamedStream(): Promise<void> {
  await logWorkflowRandomAcrossActivation();
}
