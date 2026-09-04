import { randomUUID } from 'crypto';
import type { Payload, PayloadCodec, SerializationContext } from '@temporalio/common';
import { defaultPayloadConverter } from '@temporalio/common';
import { defineSignal, setHandler } from '@temporalio/workflow';
import type { WorkflowInterceptors } from '@temporalio/workflow';
import { signalWithStartWorkflow } from '@temporalio/workflow/lib/nexus/system/generated/operations/signal-with-start-workflow';
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
const interceptorCalls: string[] = [];

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
): Promise<{ workflowId: string; runId?: string; calls: string[] }> {
  interceptorCalls.length = 0;
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
  return { workflowId: target.workflowId, runId: target.runId, calls: interceptorCalls };
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
