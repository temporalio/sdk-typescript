import { randomUUID } from 'crypto';
import type { Payload, PayloadCodec, SerializationContext } from '@temporalio/common';
import { defaultPayloadConverter, ExternalStorage } from '@temporalio/common';
import { Client } from '@temporalio/client';
import { ProtobufBinaryPayloadConverter } from '@temporalio/common/lib/converter/protobuf-payload-converters';
import { isReferencePayload } from '@temporalio/common/lib/internal-non-workflow';
import * as protoRoot from '@temporalio/proto';
import { defineSignal, setHandler } from '@temporalio/workflow';
import type { WorkflowInterceptors } from '@temporalio/workflow';
import { signalWithStartWorkflow } from '@temporalio/workflow/lib/nexus/system/generated/operations/signal-with-start-workflow';
import { makeFakeDriver } from './extstore-fake-driver';
import { helpers, makeTestFunction } from './helpers-integration';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
  workflowEnvironmentOpts: {
    server: {
      executable: {
        type: 'cached-download',
        // System Nexus is available in the same CLI/server build used by the Python and .NET SDK suites.
        version: 'v1.8.3-server-1.32.0-162.0',
      },
      extraArgs: ['--dynamic-config-value', 'history.enableSignalWithStartFromWorkflow=true'],
    },
  },
});

export const systemNexusSignal = defineSignal<[string]>('system-nexus-signal');
export const systemNexusLargeSignal = defineSignal<[Uint8Array]>('system-nexus-large-signal');
const interceptorCalls: string[] = [];
let interceptedNamespace: string | undefined;

export function interceptors(): WorkflowInterceptors {
  return {
    outbound: [
      {
        startNexusOperation(input, next) {
          interceptorCalls.push('ordinary');
          return next(input);
        },
        startSystemNexusOperation(input, next) {
          interceptorCalls.push('generic');
          return next(input);
        },
        signalWithStartWorkflow(input, next) {
          interceptorCalls.push('specific');
          interceptedNamespace = input.namespace;
          return next({ ...input, headers: { context: 'context-header' } });
        },
      },
    ],
  };
}

class ContextRecordingCodec implements PayloadCodec {
  readonly contexts = new Map<string, SerializationContext[]>();

  async encode(payloads: Payload[], context?: SerializationContext): Promise<Payload[]> {
    this.record(payloads, context);
    return payloads;
  }

  async decode(payloads: Payload[], context?: SerializationContext): Promise<Payload[]> {
    this.record(payloads, context);
    return payloads;
  }

  private record(payloads: Payload[], context?: SerializationContext): void {
    for (const payload of payloads) {
      const value = defaultPayloadConverter.fromPayload(payload);
      if (
        value === 'context-workflow-arg' ||
        value === 'context-signal-arg' ||
        value === 'context-memo' ||
        value === 'context-summary' ||
        value === 'context-details' ||
        value === 'context-header'
      ) {
        const contexts = this.contexts.get(value) ?? [];
        contexts.push(context!);
        this.contexts.set(value, contexts);
      }
    }
  }
}

class ByteIncrementingCodec implements PayloadCodec {
  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => ({ ...payload, data: payload.data?.map((byte) => byte + 1) }));
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => ({ ...payload, data: payload.data?.map((byte) => byte - 1) }));
  }
}

export async function systemNexusTarget(startArgument: string): Promise<[string, string]> {
  let resolveSignal!: (value: string) => void;
  const signal = new Promise<string>((resolve) => {
    resolveSignal = resolve;
  });
  setHandler(systemNexusSignal, (value) => resolveSignal(value));
  return [startArgument, await signal];
}

export async function systemNexusCaller(
  targetWorkflowId: string,
  taskQueue: string
): Promise<{ workflowId: string; runId?: string; calls: string[]; namespace?: string }> {
  interceptorCalls.length = 0;
  interceptedNamespace = undefined;
  const target = await signalWithStartWorkflow({
    workflow: systemNexusTarget,
    args: ['context-workflow-arg'],
    id: targetWorkflowId,
    taskQueue,
    signal: systemNexusSignal,
    signalArgs: ['context-signal-arg'],
    memo: { context: 'context-memo' },
    staticSummary: 'context-summary',
    staticDetails: 'context-details',
  });
  return {
    workflowId: target.workflowId,
    runId: target.runId,
    calls: interceptorCalls,
    namespace: interceptedNamespace,
  };
}

export async function systemNexusExternalStorageTarget(startArgument: Uint8Array): Promise<[number, number]> {
  let resolveSignal!: (value: Uint8Array) => void;
  const signal = new Promise<Uint8Array>((resolve) => {
    resolveSignal = resolve;
  });
  setHandler(systemNexusLargeSignal, (value) => resolveSignal(value));
  return [startArgument.byteLength, (await signal).byteLength];
}

export async function systemNexusExternalStorageCaller(
  targetWorkflowId: string,
  taskQueue: string,
  payloadSize: number
): Promise<{ workflowId: string; runId?: string }> {
  const payload = new Uint8Array(payloadSize).fill(1);
  const target = await signalWithStartWorkflow({
    workflow: systemNexusExternalStorageTarget,
    args: [payload],
    id: targetWorkflowId,
    taskQueue,
    signal: systemNexusLargeSignal,
    signalArgs: [payload],
    memo: { payload },
  });
  return { workflowId: target.workflowId, runId: target.runId };
}

test('signal-with-start invokes the generated public API from a workflow', async (t) => {
  const { createWorker, startWorkflow, taskQueue } = helpers(t);
  const codec = new ContextRecordingCodec();
  const worker = await createWorker({ dataConverter: { payloadCodecs: [codec] } });
  const targetWorkflowId = `system-nexus-target-${randomUUID()}`;
  const caller = await startWorkflow(systemNexusCaller, {
    args: [targetWorkflowId, taskQueue],
  });
  const target = await worker.runUntil(caller.result());
  t.is(target.workflowId, targetWorkflowId);
  t.regex(target.runId ?? '', /^[0-9a-f-]+$/i);
  t.deepEqual(await t.context.env.client.workflow.getHandle(target.workflowId, target.runId).result(), [
    'context-workflow-arg',
    'context-signal-arg',
  ]);
  const expectedContext = { type: 'workflow' as const, namespace: 'default', workflowId: targetWorkflowId };
  t.deepEqual(target.calls, ['specific', 'generic']);
  t.is(target.namespace, 'default');
  for (const value of [
    'context-workflow-arg',
    'context-signal-arg',
    'context-memo',
    'context-summary',
    'context-details',
    'context-header',
  ]) {
    const contexts = codec.contexts.get(value) ?? [];
    t.true(contexts.length >= 1, `${value} should be encoded with the target context`);
    t.deepEqual(
      contexts,
      contexts.map(() => expectedContext)
    );
  }
});

test('signal-with-start externally stores payloads nested in its request envelope', async (t) => {
  const { createWorker, taskQueue } = helpers(t);
  const driver = makeFakeDriver();
  const payloadSize = 4096;
  const codec = new ByteIncrementingCodec();
  const worker = await createWorker({
    dataConverter: {
      payloadCodecs: [codec],
      externalStorage: new ExternalStorage({ drivers: [driver], payloadSizeThreshold: 1024 }),
    },
  });
  const client = new Client({
    connection: t.context.env.connection,
    namespace: t.context.env.client.options.namespace,
    dataConverter: { payloadCodecs: [codec] },
  });
  const targetWorkflowId = `system-nexus-extstore-target-${randomUUID()}`;
  const caller = await client.workflow.start(systemNexusExternalStorageCaller, {
    taskQueue,
    workflowId: randomUUID(),
    args: [targetWorkflowId, taskQueue, payloadSize],
  });
  const target = await worker.runUntil(caller.result());

  t.deepEqual(await client.workflow.getHandle(target.workflowId, target.runId).result(), [payloadSize, payloadSize]);
  const { events } = await caller.fetchHistory();
  const envelope = events?.find((event) => event.nexusOperationScheduledEventAttributes != null)
    ?.nexusOperationScheduledEventAttributes?.input;
  t.truthy(envelope, 'expected the System Nexus operation envelope in caller history');
  t.false(isReferencePayload(envelope!), 'the outer System Nexus envelope must remain inline');
  const request = new ProtobufBinaryPayloadConverter(protoRoot).fromPayload<any>(envelope!);
  t.true(isReferencePayload(request.input?.payloads?.[0]), 'workflow argument should be externally stored');
  t.true(isReferencePayload(request.signalInput?.payloads?.[0]), 'signal argument should be externally stored');
  t.true(isReferencePayload(request.memo?.fields?.payload), 'memo value should be externally stored');
  t.deepEqual(
    driver.storeCalls[0]?.payloads[0]?.data,
    new Uint8Array(payloadSize).fill(2),
    'external storage should receive the codec-encoded payload'
  );
  t.deepEqual(
    driver.storeCalls.map((call) => call.context.target?.id),
    [targetWorkflowId, targetWorkflowId, targetWorkflowId]
  );
});
