import test from 'ava';
import type { ConnectionLike } from '@temporalio/client';
import { Client, WithStartWorkflowOperation } from '@temporalio/client';
import type { PayloadCodec } from '@temporalio/common';
import { defaultPayloadConverter } from '@temporalio/common';
import { msToTs } from '@temporalio/common/time';
import { temporal } from '@temporalio/proto';
import { WorkflowCodecRunner } from '@temporalio/worker/internal';

// In-place modification catches accidental sharing of caller-owned payload bytes.
const codec: PayloadCodec = {
  async encode(payloads) {
    for (const payload of payloads)
      payload.data?.forEach((byte, index, data) => {
        data[index] = byte + 1;
      });
    return payloads;
  },
  async decode(payloads) {
    for (const payload of payloads)
      payload.data?.forEach((byte, index, data) => {
        data[index] = byte - 1;
      });
    return payloads;
  },
};
const context = { type: 'workflow' as const, namespace: 'default', workflowId: 'wf' };
const headers = { custom: defaultPayloadConverter.toPayload('header') };

for (const enabled of [false, true]) {
  test(`header codecs round trip at workflow boundaries (enabled=${enabled})`, async (t) => {
    const encoded = enabled
      ? (await codec.encode(structuredClone([headers.custom])))[0]!
      : structuredClone(headers.custom);
    const runner = new WorkflowCodecRunner([codec], context, enabled);
    const decoded = await runner.decodeActivation({
      runId: 'run',
      jobs: [{ signalWorkflow: { signalName: 'signal', headers: { custom: structuredClone(encoded) } } }],
    });
    t.deepEqual(decoded.jobs?.[0]?.signalWorkflow?.headers?.custom?.data, headers.custom.data);
    const completion = await runner.encodeCompletion({
      successful: { commands: [{ continueAsNewWorkflowExecution: { headers: structuredClone(headers) } }] },
    });
    t.deepEqual(
      completion.successful?.commands?.[0]?.continueAsNewWorkflowExecution?.headers?.custom?.data,
      encoded.data
    );
  });
}

test('client Payload headers stay wire-ready through starts, schedules, and update retries', async (t) => {
  const headers = {
    custom: {
      metadata: { encoding: new TextEncoder().encode('binary/encrypted') },
      data: new TextEncoder().encode('wire-ready'),
    },
  };
  const originalHeaders = structuredClone(headers);
  let start: temporal.api.workflowservice.v1.IStartWorkflowExecutionRequest | undefined;
  let schedule: temporal.api.schedule.v1.ISchedule | null | undefined;
  const multiOperations: temporal.api.workflowservice.v1.IExecuteMultiOperationRequest[] = [];
  const connection = {
    plugins: [],
    workflowService: {
      startWorkflowExecution: async (req: typeof start) => {
        start = req;
        return { runId: 'run' };
      },
      createSchedule: async (req: temporal.api.workflowservice.v1.ICreateScheduleRequest) => {
        schedule = req.schedule;
        return {};
      },
      describeSchedule: async () => ({ schedule, info: { createTime: msToTs('1s') } }),
      updateSchedule: async (req: temporal.api.workflowservice.v1.IUpdateScheduleRequest) => {
        schedule = req.schedule;
        return {};
      },
      executeMultiOperation: async (req: temporal.api.workflowservice.v1.IExecuteMultiOperationRequest) => {
        multiOperations.push(structuredClone(req));
        const stages = temporal.api.enums.v1.UpdateWorkflowExecutionLifecycleStage;
        return {
          responses: [
            { startWorkflow: { runId: 'run' } },
            {
              updateWorkflow: {
                stage:
                  multiOperations.length === 1
                    ? stages.UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_ADMITTED
                    : stages.UPDATE_WORKFLOW_EXECUTION_LIFECYCLE_STAGE_ACCEPTED,
                updateRef: { workflowExecution: { workflowId: 'wf', runId: 'run' } },
              },
            },
          ],
        };
      },
    },
  } as unknown as ConnectionLike;
  const client = new Client({
    connection,
    dataConverter: { payloadCodecs: [codec] },
    interceptors: {
      workflow: [
        {
          start: (input, next) => next({ ...input, headers }),
          startUpdateWithStart: (input, next) =>
            next({ ...input, workflowStartHeaders: headers, updateHeaders: headers }),
        },
      ],
      schedule: [
        {
          create: (input, next) => next({ ...input, headers }),
        },
      ],
    },
  });
  await client.workflow.start('workflow', { taskQueue: 'queue', workflowId: 'wf' });
  const handle = await client.schedule.create({
    scheduleId: 'schedule',
    spec: { intervals: [{ every: '1h' }] },
    action: { type: 'startWorkflow', workflowType: 'workflow', taskQueue: 'queue', workflowId: 'wf' },
  });
  const original = structuredClone(schedule?.action?.startWorkflow?.header?.fields);
  t.deepEqual(original, start?.header?.fields);
  t.deepEqual(start?.header?.fields, originalHeaders);
  await handle.update((current) => current);
  await handle.update((current) => current);
  t.deepEqual(schedule?.action?.startWorkflow?.header?.fields, original);
  await client.workflow.startUpdateWithStart('update', {
    waitForStage: 'ACCEPTED',
    startWorkflowOperation: new WithStartWorkflowOperation('workflow', {
      workflowId: 'wf',
      taskQueue: 'queue',
      workflowIdConflictPolicy: 'USE_EXISTING',
    }),
  });
  t.is(multiOperations.length, 2);
  for (const req of multiOperations) {
    t.deepEqual(req.operations?.[0]?.startWorkflow?.header?.fields, original);
    t.deepEqual(req.operations?.[1]?.updateWorkflow?.request?.input?.header?.fields, original);
  }
  t.deepEqual(headers, originalHeaders);
});
