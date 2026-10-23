/**
 * A `PayloadValidationError` thrown by the payload converter while converting a payload produced by
 * Workflow code (i.e. an outbound command, or the Workflow's result) must fail the Workflow Task,
 * not the Workflow Execution.
 *
 * Each scenario runs the same Workflow, which executes a single outbound command selected by its
 * input, on a Worker whose payload converter always rejects payloads containing a marker value. It
 * asserts that a Workflow Task fails with the `PayloadValidationError` while the Workflow Execution
 * stays open, then terminates the Workflow.
 */
import { randomUUID } from 'crypto';
import * as nexus from 'nexus-rpc';
import type { ExecutionContext } from 'ava';
import { ApplicationFailure, createPayloadValidationError, defaultPayloadConverter } from '@temporalio/common';
import type { WorkflowHandle } from '@temporalio/client';
import { WorkflowFailedError } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import type { Worker, WorkerOptions } from '@temporalio/worker';
import * as workflow from '@temporalio/workflow';
import { signalWithStartWorkflow } from '@temporalio/workflow';
import type { Context as BaseContext } from './helpers-integration';
import {
  createTestWorkflowBundle,
  createTestWorkflowEnvironment,
  helpers,
  makeConfigurableEnvironmentTestFn,
} from './helpers-integration';
import { waitUntil } from './helpers';
import {
  PVE_MARKER,
  RETRYABLE_LOOKALIKE_MARKER,
  SELF_REJECTING_PVE_MARKER,
  UNRELATED_ERROR_MARKER,
} from './payload-converters/payload-validation-outbound';

const { EventType } = temporal.api.enums.v1;

type Context = BaseContext;

const rejectingPayloadConverterPath = require.resolve('./payload-converters/payload-validation-outbound');

const baseTest = makeConfigurableEnvironmentTestFn<Context>({
  createTestContext: async () => {
    const env = await createTestWorkflowEnvironment({
      server: {
        executable: {
          type: 'cached-download',
          // Same server build as test-integration-system-nexus, which supports workflow-side signal-with-start
          version: 'v1.8.3-server-1.32.0-162.0',
        },
        extraArgs: ['--dynamic-config-value', 'history.enableSignalWithStartFromWorkflow=true'],
      },
    });
    try {
      // Workflows are bundled with the marker-rejecting payload converter
      const workflowBundle = await createTestWorkflowBundle({
        workflowsPath: __filename,
        payloadConverterPath: rejectingPayloadConverterPath,
      });
      return { env, workflowBundle };
    } catch (err) {
      await env.teardown();
      throw err;
    }
  },
  teardown: async (context) => context?.env?.teardown(),
});

// Run serially: dozens of concurrent Workers overload the dev server on CI, and a timed out first Workflow Task
// hides the PayloadValidationError, since later attempts are transient and don't record their failures in history.
const test = baseTest.serial;

////////////////////////////////////////////////////////////////////////////////////////////////////
// Workflows

const echoService = nexus.service('pve-outbound-echo', {
  echo: nexus.operation<string, string>(),
});

const activities = {
  async echo(value: string): Promise<string> {
    return value;
  },
};

const { echo } = workflow.proxyActivities<typeof activities>({ startToCloseTimeout: '30s' });
const { echo: localEcho } = workflow.proxyLocalActivities<typeof activities>({ startToCloseTimeout: '30s' });

export const markerSignal = workflow.defineSignal<[string]>('marker');
export const triggerSignal = workflow.defineSignal('trigger');
export const triggerUpdate = workflow.defineUpdate<string>('trigger');

export type OutboundCase =
  | 'activity'
  | 'activityCaught'
  | 'activitySummary'
  | 'localActivity'
  | 'localActivitySummary'
  | 'nexus'
  | 'nexusSummary'
  | 'childStart'
  | 'childMemo'
  | 'childStaticSummary'
  | 'childStaticDetails'
  | 'childSignal'
  | 'externalSignal'
  | 'systemNexusSignalWithStart'
  | 'memo'
  | 'userMetadata'
  | 'complete'
  | 'continueAsNew'
  | 'continueAsNewMemo'
  | 'signalHandler'
  | 'updateHandler'
  | 'catchThenThrow';

export interface OutboundInput {
  case: OutboundCase;
  /** Value placed in the outbound payload selected by `case` */
  marker: string;
  endpoint?: string;
}

export async function signalTargetWorkflow(): Promise<string> {
  let received: string | undefined;
  workflow.setHandler(markerSignal, (value) => void (received = value));
  await workflow.condition(() => received !== undefined);
  return received!;
}

export async function childWorkflow(value: string): Promise<string> {
  return value;
}

export async function outboundPayloadWorkflow(input: OutboundInput): Promise<string> {
  const { marker } = input;
  switch (input.case) {
    case 'activity':
      await echo(marker);
      break;
    case 'activityCaught':
      // Even if Workflow code handles the error, the Workflow Task must fail
      try {
        await echo(marker);
      } catch (_err) {
        return 'caught';
      }
      break;
    case 'activitySummary':
      await workflow.proxyActivities<typeof activities>({ startToCloseTimeout: '30s', summary: marker }).echo('x');
      break;
    case 'localActivity':
      await localEcho(marker);
      break;
    case 'localActivitySummary':
      await workflow.proxyLocalActivities<typeof activities>({ startToCloseTimeout: '30s', summary: marker }).echo('x');
      break;
    case 'nexusSummary': {
      const client = workflow.createNexusServiceClient({ endpoint: input.endpoint!, service: echoService });
      await client.executeOperation('echo', 'x', { scheduleToCloseTimeout: '30s', summary: marker });
      break;
    }
    case 'nexus': {
      const client = workflow.createNexusServiceClient({ endpoint: input.endpoint!, service: echoService });
      await client.executeOperation('echo', marker, { scheduleToCloseTimeout: '30s' });
      break;
    }
    case 'childStart':
      await workflow.executeChild(childWorkflow, { args: [marker] });
      break;
    case 'childMemo':
      await workflow.executeChild(childWorkflow, { args: ['child'], memo: { key: marker } });
      break;
    case 'childStaticSummary':
      await workflow.executeChild(childWorkflow, { args: ['child'], staticSummary: marker });
      break;
    case 'childStaticDetails':
      await workflow.executeChild(childWorkflow, { args: ['child'], staticDetails: marker });
      break;
    case 'childSignal': {
      const child = await workflow.startChild(signalTargetWorkflow);
      await child.signal(markerSignal, marker);
      await child.result();
      break;
    }
    case 'externalSignal': {
      const child = await workflow.startChild(signalTargetWorkflow);
      await workflow.getExternalWorkflowHandle(child.workflowId).signal(markerSignal, marker);
      await child.result();
      break;
    }
    case 'systemNexusSignalWithStart': {
      const { workflowId, taskQueue } = workflow.workflowInfo();
      await signalWithStartWorkflow({
        workflow: signalTargetWorkflow,
        args: [],
        id: `${workflowId}-target`,
        taskQueue,
        signal: markerSignal,
        signalArgs: [marker],
      });
      break;
    }
    case 'memo':
      workflow.upsertMemo({ key: marker });
      break;
    case 'userMetadata':
      await workflow.sleep(1, { summary: marker });
      break;
    case 'complete':
      return marker;
    case 'continueAsNew':
      await workflow.continueAsNew<typeof outboundPayloadWorkflow>(input);
      break;
    case 'continueAsNewMemo':
      await workflow.makeContinueAsNewFunc<typeof outboundPayloadWorkflow>({ memo: { key: marker } })(input);
      break;
    case 'signalHandler': {
      // The test sends `triggerSignal` with signal-with-start
      let done = false;
      workflow.setHandler(triggerSignal, async () => {
        await echo(marker);
        done = true;
      });
      await workflow.condition(() => done);
      break;
    }
    case 'updateHandler': {
      // The test sends `triggerUpdate`
      let done = false;
      workflow.setHandler(triggerUpdate, async () => {
        await echo(marker);
        done = true;
        return 'updated';
      });
      await workflow.condition(() => done);
      break;
    }
    case 'catchThenThrow':
      // The PayloadValidationError must still be what fails the Workflow Task
      try {
        await echo(marker);
      } catch (_err) {
        throw new TypeError('thrown after catching the PayloadValidationError');
      }
      break;
  }
  return 'done';
}

/** Same as {@link outboundPayloadWorkflow}, but configured to fail the Workflow Execution on any `Error`. */
export async function outboundPayloadWorkflowFailingOnAnyError(input: OutboundInput): Promise<string> {
  return await outboundPayloadWorkflow(input);
}
workflow.setWorkflowOptions({ failureExceptionTypes: [Error] }, outboundPayloadWorkflowFailingOnAnyError);

/**
 * Records a Workflow Task error (thrown by the Workflow function) before a rejected outbound
 * conversion (in a signal handler) in the same activation. The test sends `triggerSignal` with
 * signal-with-start.
 */
export async function errorThenPayloadValidationErrorWorkflow(marker: string): Promise<void> {
  workflow.setHandler(triggerSignal, async () => {
    // Let the Workflow function's error be recorded first
    for (let i = 0; i < 20; i++) await Promise.resolve();
    try {
      workflow.upsertMemo({ key: marker });
    } catch (_err) {
      // Caught, so that the PayloadValidationError isn't recorded again by the signal handler
    }
  });
  throw new TypeError('recorded before the PayloadValidationError');
}

export async function throwPayloadValidationErrorWorkflow(): Promise<never> {
  throw createPayloadValidationError({ reason: 'thrown by workflow code' });
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Helpers

/** Create a Worker using the marker-rejecting payload converter. */
async function createRejectingWorker(
  t: ExecutionContext<Context>,
  opts?: Partial<WorkerOptions> & { nexus?: boolean }
): Promise<Worker> {
  const { nexus: withNexus, ...workerOpts } = opts ?? {};
  return await helpers(t).createWorker({
    activities,
    nexusServices: withNexus
      ? [nexus.serviceHandler(echoService, { echo: async (_ctx, value: string) => value })]
      : undefined,
    dataConverter: { payloadConverterPath: rejectingPayloadConverterPath },
    ...workerOpts,
  });
}

/** Poll the Workflow's history until a Workflow Task failure matching `predicate` appears. */
async function waitForWorkflowTaskFailure(
  handle: WorkflowHandle,
  predicate: (failure: temporal.api.failure.v1.IFailure) => boolean
): Promise<temporal.api.failure.v1.IFailure> {
  let found: temporal.api.failure.v1.IFailure | undefined;
  await waitUntil(async () => {
    found = (await historyEvents(handle))
      .filter((event) => event.eventType === EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED)
      .map((event) => event.workflowTaskFailedEventAttributes?.failure ?? {})
      .find(predicate);
    return found !== undefined;
  }, 60_000);
  return found!;
}

function isPayloadValidationFailure(failure: temporal.api.failure.v1.IFailure): boolean {
  return (
    failure.message === 'Payload validation failed' &&
    failure.applicationFailureInfo?.type === 'PayloadValidationError' &&
    failure.applicationFailureInfo?.nonRetryable === true
  );
}

/** Assert that the Workflow Execution hasn't failed or otherwise closed. */
async function assertStillRunning(t: ExecutionContext<Context>, handle: WorkflowHandle): Promise<void> {
  t.false(hasEvent(await historyEvents(handle), EventType.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED));
  t.is((await handle.describe()).status.name, 'RUNNING');
}

async function historyEvents(handle: WorkflowHandle): Promise<temporal.api.history.v1.IHistoryEvent[]> {
  return (await handle.fetchHistory()).events ?? [];
}

function hasEvent(events: temporal.api.history.v1.IHistoryEvent[], eventType: number): boolean {
  return events.some((event) => event.eventType === eventType);
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Tests

interface OutboundTestCase {
  case: OutboundCase;
  title?: string;
  /** Value the payload converter rejects (defaults to {@link PVE_MARKER}) */
  marker?: string;
  /** Expected `reason` in the details of the PayloadValidationError reported by the Workflow Task failure */
  expectedReason?: string;
  /** Whether the converter also rejects the PayloadValidationError's details */
  expectPayloadFreeFailure?: boolean;
}

const baseCases: OutboundTestCase[] = [
  { case: 'activity' },
  {
    // The Workflow Task failure falls back to a payload-free PayloadValidationError
    case: 'activity',
    title: 'activity (converter rejects the PVE details)',
    marker: SELF_REJECTING_PVE_MARKER,
    expectPayloadFreeFailure: true,
  },
  { case: 'activityCaught' },
  { case: 'activitySummary' },
  { case: 'localActivity' },
  { case: 'localActivitySummary' },
  { case: 'nexus' },
  { case: 'nexusSummary' },
  { case: 'childStart' },
  { case: 'childMemo' },
  { case: 'childStaticSummary' },
  { case: 'childStaticDetails' },
  { case: 'childSignal' },
  { case: 'externalSignal' },
  { case: 'systemNexusSignalWithStart' },
  { case: 'memo' },
  { case: 'userMetadata' },
  { case: 'complete' },
  { case: 'continueAsNew' },
  { case: 'continueAsNewMemo' },
  { case: 'signalHandler' },
  { case: 'updateHandler' },
  { case: 'catchThenThrow' },
];

// Each case also runs on a Worker configured to fail the Workflow Execution on any `Error`, which
// must not apply to these Workflow Task failures.
const failureTypesVariants: { suffix: string; rejectingWorkerOptions?: Partial<WorkerOptions> }[] = [
  { suffix: '' },
  {
    suffix: ' with workflowFailureErrorTypes Error',
    rejectingWorkerOptions: { workflowFailureErrorTypes: { '*': ['Error'] } },
  },
];

const cases: (OutboundTestCase & {
  suffix: string;
  rejectingWorkerOptions?: Partial<WorkerOptions>;
  workflowType?: typeof outboundPayloadWorkflow;
})[] = [
  ...failureTypesVariants.flatMap((variant) => baseCases.map((c) => ({ ...c, ...variant }))),
  // The same, with the failure exception types set on the Workflow definition
  ...(['activity', 'catchThenThrow', 'updateHandler', 'complete'] as const).map((outboundCase) => ({
    ...baseCases.find((c) => c.case === outboundCase)!,
    suffix: ' with Workflow failureExceptionTypes Error',
    workflowType: outboundPayloadWorkflowFailingOnAnyError,
  })),
];

for (const {
  case: outboundCase,
  title = outboundCase,
  marker = PVE_MARKER,
  expectedReason = 'outbound payload rejected by test converter',
  expectPayloadFreeFailure = false,
  suffix,
  rejectingWorkerOptions,
  workflowType = outboundPayloadWorkflow,
} of cases) {
  test(`PayloadValidationError converting outbound ${title} payload fails the Workflow Task${suffix}`, async (t) => {
    const { env } = t.context;
    const h = helpers(t);
    const endpoint = outboundCase.startsWith('nexus') ? (await h.registerNexusEndpoint()).endpointName : undefined;
    const worker = await createRejectingWorker(t, { nexus: endpoint !== undefined, ...rejectingWorkerOptions });

    // The client uses the default payload converter, so the Workflow starts normally.
    const startOptions = {
      taskQueue: h.taskQueue,
      workflowId: randomUUID(),
      args: [{ case: outboundCase, marker, endpoint }] as [OutboundInput],
    };
    const handle =
      outboundCase === 'signalHandler'
        ? await env.client.workflow.signalWithStart(workflowType, { ...startOptions, signal: triggerSignal })
        : await env.client.workflow.start(workflowType, startOptions);
    if (outboundCase === 'updateHandler') {
      // Not awaited: the update can't complete while the Workflow Task keeps failing
      handle.executeUpdate(triggerUpdate).catch(() => undefined);
    }

    const taskFailure = await worker.runUntil(waitForWorkflowTaskFailure(handle, isPayloadValidationFailure));
    const details = taskFailure.applicationFailureInfo?.details?.payloads ?? [];
    if (expectPayloadFreeFailure) {
      t.is(details.length, 0);
    } else {
      t.is(details.length, 1);
      t.deepEqual(defaultPayloadConverter.fromPayload(details[0]!), { reason: expectedReason });
    }
    await assertStillRunning(t, handle);
    await handle.terminate('test complete');
  });
}

test('PayloadValidationError thrown by Workflow code fails the Workflow Execution', async (t) => {
  const { env } = t.context;
  const h = helpers(t);
  const worker = await createRejectingWorker(t);
  const handle = await env.client.workflow.start(throwPayloadValidationErrorWorkflow, {
    taskQueue: h.taskQueue,
    workflowId: randomUUID(),
  });
  const err = await worker.runUntil(async () => t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError }));
  t.true(err?.cause instanceof ApplicationFailure);
  const cause = err?.cause as ApplicationFailure;
  t.is(cause.type, 'PayloadValidationError');
  t.true(cause.nonRetryable);
  t.deepEqual(cause.details, [{ reason: 'thrown by workflow code' }]);
  t.false(hasEvent(await historyEvents(handle), EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED));
});

test('Retryable PayloadValidationError lookalike from the converter keeps failing the Workflow Execution', async (t) => {
  const { env } = t.context;
  const h = helpers(t);
  const worker = await createRejectingWorker(t);
  const handle = await env.client.workflow.start(outboundPayloadWorkflow, {
    taskQueue: h.taskQueue,
    workflowId: randomUUID(),
    args: [{ case: 'activity', marker: RETRYABLE_LOOKALIKE_MARKER }],
  });
  const err = await worker.runUntil(async () => t.throwsAsync(handle.result(), { instanceOf: WorkflowFailedError }));
  t.true(err?.cause instanceof ApplicationFailure);
  const cause = err?.cause as ApplicationFailure;
  t.is(cause.type, 'PayloadValidationError');
  t.false(cause.nonRetryable);
  t.false(hasEvent(await historyEvents(handle), EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED));
});

test('Unrelated converter error keeps failing the Workflow Task with that error', async (t) => {
  const { env } = t.context;
  const h = helpers(t);
  const worker = await createRejectingWorker(t);
  const handle = await env.client.workflow.start(outboundPayloadWorkflow, {
    taskQueue: h.taskQueue,
    workflowId: randomUUID(),
    args: [{ case: 'activity', marker: UNRELATED_ERROR_MARKER }],
  });
  const taskFailure = await worker.runUntil(
    waitForWorkflowTaskFailure(handle, (failure) => failure.message === 'Unrelated converter failure')
  );
  t.not(taskFailure.applicationFailureInfo?.type, 'PayloadValidationError');
  await assertStillRunning(t, handle);
  await handle.terminate('test complete');
});

test('Unrelated converter error caught by Workflow code does not fail the Workflow Task', async (t) => {
  const { env } = t.context;
  const h = helpers(t);
  const worker = await createRejectingWorker(t);
  const handle = await env.client.workflow.start(outboundPayloadWorkflow, {
    taskQueue: h.taskQueue,
    workflowId: randomUUID(),
    args: [{ case: 'activityCaught', marker: UNRELATED_ERROR_MARKER }],
  });
  t.is(await worker.runUntil(handle.result()), 'caught');
  t.false(hasEvent(await historyEvents(handle), EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED));
});

test('PayloadValidationError replaces a Workflow Task error recorded before it', async (t) => {
  const { env } = t.context;
  const h = helpers(t);
  const worker = await createRejectingWorker(t);
  const handle = await env.client.workflow.signalWithStart(errorThenPayloadValidationErrorWorkflow, {
    taskQueue: h.taskQueue,
    workflowId: randomUUID(),
    args: [PVE_MARKER],
    signal: triggerSignal,
  });
  // The first Workflow Task failure must already be the PayloadValidationError
  await worker
    .runUntil(waitForWorkflowTaskFailure(handle, () => true))
    .then((failure) => t.true(isPayloadValidationFailure(failure)));
  await assertStillRunning(t, handle);
  await handle.terminate('test complete');
});
