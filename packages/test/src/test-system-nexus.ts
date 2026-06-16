import * as workflow from '@temporalio/workflow';
import { Client } from '@temporalio/client';
import { workflowInterceptorModules } from '@temporalio/testing';
import { bundleWorkflowCode } from '@temporalio/worker';
import type { TestWorkflowEnvironment } from './helpers';
import { bundlerOptions } from './helpers';
import type { Context } from './helpers-integration';
import {
  configurableHelpers,
  createTestWorkflowEnvironment,
  makeConfigurableEnvironmentTestFn,
} from './helpers-integration';
import {
  makeSystemNexusTestTrace,
  SystemNexusTestPayloadCodec,
  type SystemNexusTestTrace,
} from './payload-converters/system-nexus-payload-converter';

const SYSTEM_NEXUS_CLI_VERSION = 'v1.7.1-system-nexus-operations';
const converterPath = require.resolve('./payload-converters/system-nexus-payload-converter');
const dataConverter = {
  payloadConverterPath: converterPath,
  payloadCodecs: [new SystemNexusTestPayloadCodec()],
};
const testSignal = workflow.defineSignal<[SystemNexusTestTrace]>('test-signal');

const test = makeConfigurableEnvironmentTestFn<Context>({
  createTestContext: async () => {
    const env = await createTestWorkflowEnvironment({
      server: {
        executable: {
          type: 'cached-download',
          version: SYSTEM_NEXUS_CLI_VERSION,
        },
      },
    });
    const workflowBundle = await bundleWorkflowCode({
      ...bundlerOptions,
      workflowInterceptorModules: [...workflowInterceptorModules],
      workflowsPath: __filename,
      payloadConverterPath: converterPath,
    });
    return { env, workflowBundle };
  },
  teardown: async (c) => {
    await c.env.teardown();
  },
});

export interface SystemNexusTargetResult {
  input: SystemNexusTestTrace;
  memo: SystemNexusTestTrace;
  signalInput: SystemNexusTestTrace;
}

export async function systemNexusTargetWorkflow(input: SystemNexusTestTrace): Promise<SystemNexusTargetResult> {
  let signalInput: SystemNexusTestTrace | undefined;
  workflow.setHandler(testSignal, (value) => {
    signalInput = value;
  });
  await workflow.condition(() => signalInput !== undefined);
  return {
    input,
    memo: workflow.workflowInfo().memo?.memoKey as SystemNexusTestTrace,
    signalInput: signalInput!,
  };
}

export async function signalWithStartWorkflowCaller(taskQueue: string, workflowId: string): Promise<string> {
  const handle = await workflow.signalWithStartWorkflow({
    workflow: systemNexusTargetWorkflow,
    args: [makeSystemNexusTestTrace('workflow-input')],
    id: workflowId,
    taskQueue,
    signal: testSignal,
    signalArgs: [makeSystemNexusTestTrace('signal-input')],
    memo: { memoKey: makeSystemNexusTestTrace('memo-value') },
    staticSummary: 'summary-value',
    staticDetails: 'details-value',
  });
  return handle.workflowId;
}

function makeClient(env: TestWorkflowEnvironment): Client {
  return new Client({
    connection: env.client.connection,
    namespace: env.client.options.namespace,
    dataConverter,
  });
}

test('signalWithStartWorkflow starts and signals a workflow through system Nexus with custom payload conversion', async (t) => {
  const { createWorker, taskQueue } = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const workflowId = `system-nexus-signal-with-start-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const worker = await createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const startedWorkflowId = await client.workflow.execute(signalWithStartWorkflowCaller, {
      args: [taskQueue, workflowId],
      taskQueue,
      workflowId: `${workflowId}-caller`,
    });
    t.is(startedWorkflowId, workflowId);

    const result = await client.workflow.getHandle<typeof systemNexusTargetWorkflow>(workflowId).result();
    t.deepEqual(result.input, {
      label: 'workflow-input',
      trace: [
        'payload.encode|workflow-input',
        'codec.encode|workflow-input',
        'codec.decode|workflow-input',
        'payload.decode|workflow-input',
      ],
    });
    t.deepEqual(result.signalInput, {
      label: 'signal-input',
      trace: [
        'payload.encode|signal-input',
        'codec.encode|signal-input',
        'codec.decode|signal-input',
        'payload.decode|signal-input',
      ],
    });
    t.deepEqual(result.memo, {
      label: 'memo-value',
      trace: [
        'payload.encode|memo-value',
        'codec.encode|memo-value',
        'codec.decode|memo-value',
        'payload.decode|memo-value',
      ],
    });
  });
});
