import {
  condition,
  defineQuery,
  defineSignal,
  getRandomStream,
  setHandler,
  sleep,
  startChild,
  uuid4,
  workflowInfo,
  workflowRandom,
} from '@temporalio/workflow';

export interface RandomStreamResetCapture {
  random: number;
  uuid: string;
  childWorkflowId: string;
}

export const randomStreamResetCapturesQuery = defineQuery<RandomStreamResetCapture[]>('randomStreamResetCaptures');
export const randomStreamResetUnblockSignal = defineSignal('randomStreamResetUnblock');

async function logWorkflowRandomAcrossActivation(): Promise<void> {
  console.log('workflow', Math.random());
  await sleep(1);
  console.log('workflow', Math.random());
}

async function logWorkflowRandomStreamAcrossActivation(): Promise<void> {
  console.log('workflow-default', workflowRandom.random());
  await sleep(1);
  console.log('workflow-default', workflowRandom.random());
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

export async function randomStreamWorkflowRandomBaselineWithSleep(): Promise<void> {
  await logWorkflowRandomStreamAcrossActivation();
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

export async function randomStreamPluginInternalsScopedBaseline(): Promise<void> {
  await sleep(1);
}

export async function randomStreamPluginInternalsScopedWithWorkflowInterference(): Promise<void> {
  await logWorkflowRandomAcrossActivation();
}

export async function randomStreamPluginScopedMathAroundNext(): Promise<void> {
  await logWorkflowRandomAcrossActivation();
}

export async function randomStreamPluginScopedMathAcrossAwaitBaseline(): Promise<void> {
  await logWorkflowRandomAcrossActivation();
}

export async function randomStreamPluginScopedMathAcrossAwaitBeforeNext(): Promise<void> {
  await logWorkflowRandomAcrossActivation();
}

export async function randomStreamPluginWorkflowRandomInsideScope(): Promise<void> {
  // Intentionally empty: plugin interceptor behavior is the test surface.
}

export async function randomStreamPluginScopedUuidAcrossAwaitBaseline(): Promise<void> {
  await logWorkflowUuidAcrossActivation();
}

export async function randomStreamPluginScopedUuidAcrossAwaitBeforeNext(): Promise<void> {
  await logWorkflowUuidAcrossActivation();
}

export async function randomStreamPluginScopedUuidAroundNext(): Promise<void> {
  await logWorkflowUuidAcrossActivation();
}

export async function randomStreamPluginOutboundTimerNamedStream(): Promise<void> {
  await logWorkflowRandomAcrossActivation();
}

export async function randomStreamPluginCachedStreamSingleActivation(): Promise<void> {
  // Intentionally empty: plugin concludeActivation behavior is the test surface.
}

export async function randomStreamPluginCachedStreamAcrossActivations(): Promise<void> {
  await sleep(1);
}

export async function randomStreamResetChild(): Promise<void> {}

async function captureRandomStreamResetValues(): Promise<RandomStreamResetCapture> {
  const stream = getRandomStream('@temporalio/test/random-streams/reset');
  const random = stream.random();
  const uuid = stream.uuid4();
  const child = await startChild(randomStreamResetChild);
  return { random, uuid, childWorkflowId: child.workflowId };
}

export async function randomStreamResetWorkflow(): Promise<RandomStreamResetCapture[]> {
  const captures: RandomStreamResetCapture[] = [];
  let unblocked = false;

  setHandler(randomStreamResetCapturesQuery, () => captures);
  setHandler(randomStreamResetUnblockSignal, () => void (unblocked = true));

  captures.push(await captureRandomStreamResetValues());
  await sleep(1);
  captures.push(await captureRandomStreamResetValues());
  await condition(() => unblocked);

  return captures;
}

export async function directRandomAndUuidResetWorkflow(): Promise<RandomStreamResetCapture[]> {
  const captures: RandomStreamResetCapture[] = [];
  let unblocked = false;

  setHandler(randomStreamResetCapturesQuery, () => captures);
  setHandler(randomStreamResetUnblockSignal, () => void (unblocked = true));

  for (let iteration = 0; iteration < 4; iteration++) {
    captures.push(await captureDirectRandomAndUuidResetValues());
    await sleep(1);
  }
  await condition(() => unblocked);

  return captures;
}

async function captureDirectRandomAndUuidResetValues(): Promise<RandomStreamResetCapture> {
  const random = Math.random();
  const uuid = uuid4();
  const child = await startChild(randomStreamResetChild);
  return { random, uuid, childWorkflowId: child.workflowId };
}

export interface UnsafeRandomCapture {
  unsafe: string;
  named: string;
  float: number;
  filled: number[];
}

export const unsafeRandomQuery = defineQuery<UnsafeRandomCapture>('unsafeRandom');
export const unsafeRandomUnblockSignal = defineSignal('unsafeRandomUnblock');

export async function unsafeRandomWorkflow(): Promise<void> {
  let unblocked = false;
  setHandler(unsafeRandomQuery, () => ({
    unsafe: workflowInfo().unsafe.random.uuid4(),
    named: getRandomStream('@temporalio/test/random-streams/unsafe').uuid4(),
    float: workflowInfo().unsafe.random.random(),
    filled: Array.from(workflowInfo().unsafe.random.fillRandom(new Uint8Array(8))),
  }));
  setHandler(unsafeRandomUnblockSignal, () => void (unblocked = true));
  await condition(() => unblocked);
}
