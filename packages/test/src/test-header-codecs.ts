import test from 'ava';
import type { ConnectionLike } from '@temporalio/client';
import { Client, WithStartWorkflowOperation } from '@temporalio/client';
import type { PayloadCodec } from '@temporalio/common';
import { defaultDataConverter, defaultPayloadConverter, PayloadConverterError } from '@temporalio/common';
import { decodeHeaders, encodeHeaders } from '@temporalio/common/internal/internal-non-workflow';
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

test('header codecs reject zero or multiple resulting payloads', async (t) => {
  for (const count of [0, 2]) {
    const transform = async () => Array.from({ length: count }, () => headers.custom);
    const converter = {
      ...defaultDataConverter,
      encodeHeaders: true,
      payloadCodecs: [{ encode: transform, decode: transform }],
    };
    for (const operation of [encodeHeaders, decodeHeaders]) {
      await t.throwsAsync(operation(converter, headers, context), {
        instanceOf: PayloadConverterError,
        message: `Header 'custom' codec processing must return exactly one payload, got ${count}`,
      });
    }
  }
});

for (const enabled of [false, true]) {
  test(`header codecs round trip at workflow boundaries (enabled=${enabled})`, async (t) => {
    const converter = {
      ...defaultDataConverter,
      payloadConverter: {
        toPayload() {
          throw new Error('Payload-backed headers must not be serialized again');
        },
        fromPayload() {
          throw new Error('Header APIs must retain Payloads');
        },
      },
      payloadCodecs: [codec],
      encodeHeaders: enabled,
    };
    const original = structuredClone(headers);
    const encoded = await encodeHeaders(converter, headers, context);
    t.deepEqual(await decodeHeaders(converter, encoded, context), headers);
    t.is(Buffer.from(encoded.custom!.data!).equals(Buffer.from(headers.custom.data!)), !enabled);
    const runner = new WorkflowCodecRunner([codec], context, enabled);
    const decoded = await runner.decodeActivation({
      runId: 'run',
      jobs: [{ signalWorkflow: { signalName: 'signal', headers: encoded } }],
    });
    t.deepEqual(decoded.jobs?.[0]?.signalWorkflow?.headers?.custom?.data, headers.custom.data);
    const completion = await runner.encodeCompletion({
      successful: { commands: [{ continueAsNewWorkflowExecution: { headers } }] },
    });
    t.deepEqual(
      completion.successful?.commands?.[0]?.continueAsNewWorkflowExecution?.headers?.custom?.data,
      encoded.custom!.data
    );
    t.deepEqual(headers, original);
  });

  test(`client start and retained schedule headers are encoded once (enabled=${enabled})`, async (t) => {
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
      dataConverter: { payloadCodecs: [codec], encodeHeaders: enabled },
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
    await handle.update((current) => current);
    await handle.update((current) => current);
    t.deepEqual(schedule?.action?.startWorkflow?.header?.fields, original);
    const decoded = await decodeHeaders(
      { ...defaultDataConverter, payloadCodecs: [codec], encodeHeaders: enabled },
      start!.header!.fields!,
      context
    );
    t.deepEqual(decoded, headers);
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
  });
}
