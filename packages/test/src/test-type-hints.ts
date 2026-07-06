import { randomUUID } from 'crypto';
import type { ExecutionContext } from 'ava';
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
  Order,
  Receipt,
  workflowTypeHints,
  workflowWithTypeHints,
} from './workflows/type-hints';

const converterPath = require.resolve('./payload-converters/type-hints');
const dataConverter = { payloadConverterPath: converterPath };

function assertReceipt(t: ExecutionContext, receipt: Receipt): void {
  t.true(receipt instanceof Receipt);
  t.is(receipt.summary(), `order-1:12345`);
  t.is(typeof receipt.totalCents, 'bigint');
}

const test = makeConfigurableEnvironmentTestFn<Context>({
  createTestContext: async () => {
    const env = await createTestWorkflowEnvironment();
    const workflowBundle = await bundleWorkflowCode({
      ...bundlerOptions,
      workflowInterceptorModules: [...workflowInterceptorModules],
      workflowsPath: require.resolve('./workflows/type-hints'),
      payloadConverterPath: converterPath,
    });
    return { env, workflowBundle };
  },
  teardown: async (c) => {
    await c.env.teardown();
  },
});

function makeClient(env: TestWorkflowEnvironment): Client {
  return new Client({
    connection: env.client.connection,
    namespace: env.client.options.namespace,
    dataConverter,
  });
}

test('workflow definition with call-site type hints is invalid', async (t) => {
  const client = makeClient(t.context.env);

  await t.throwsAsync(
    client.workflow.execute(workflowWithTypeHints, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: 'unused',
      args: [new Order('order-1', 12345n)],
      typeHints: workflowTypeHints,
    }),
    {
      instanceOf: TypeError,
      message: /Workflow type hints cannot be supplied at the call site when using a workflow function/,
    }
  );
});

test('workflow execute uses definition-supplied input and output type hints', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(workflowWithTypeHints, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });

    assertReceipt(t, result);
  });
});

test('workflow start and result use definition-supplied input and output type hints', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(workflowWithTypeHints, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });

    assertReceipt(t, await handle.result());
  });
});

test('same-type continue-as-new reuses definition-supplied input and output type hints', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(workflowWithTypeHints, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n, 1)],
    });

    assertReceipt(t, result);
  });
});
