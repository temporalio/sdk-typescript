import { randomUUID } from 'crypto';
import type { ExecutionContext } from 'ava';
import { Client, WithStartWorkflowOperation, WorkflowFailedError } from '@temporalio/client';
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
  parentWorkflowChildDefinition,
  parentWorkflowChildDefinitionInvalidCallSiteTypeInfo,
  continueAsNewToWorkflowWithTypeInfo,
  finishSignal,
  finishUpdate,
  Order,
  parentWorkflowChildString,
  Receipt,
  workflowTypeInfo,
  workflowWithSignalStart,
  workflowWithTypeInfo,
  workflowWithUpdateStart,
} from './workflows/type-info';

const converterPath = require.resolve('./payload-converters/type-info');
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
      workflowsPath: require.resolve('./workflows/type-info'),
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

test('workflow definition with call-site type information is invalid', async (t) => {
  const client = makeClient(t.context.env);

  await t.throwsAsync(
    client.workflow.execute(workflowWithTypeInfo, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: 'unused',
      args: [new Order('order-1', 12345n)],
      typeInfo: workflowTypeInfo,
    }),
    {
      instanceOf: TypeError,
      message: /Workflow type information cannot be supplied at the call site when using a workflow function/,
    }
  );
});

test('workflow execute uses definition-supplied input and output type information', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(workflowWithTypeInfo, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });

    assertReceipt(t, result);
  });
});

test('workflow start and result use definition-supplied input and output type information', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(workflowWithTypeInfo, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });

    assertReceipt(t, await handle.result());
  });
});

test('workflow execute uses call-site input and output type information for string workflow type', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const result = await client.workflow.execute('workflowWithTypeInfo', {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
      typeInfo: workflowTypeInfo,
    });

    assertReceipt(t, result);
  });
});

test('workflow start and result use call-site input and output type information for string workflow type', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const handle = await client.workflow.start('workflowWithTypeInfo', {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
      typeInfo: workflowTypeInfo,
    });

    assertReceipt(t, await handle.result());
  });
});

test('detached workflow handle uses call-site output type information', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const workflowId = `wf-${randomUUID()}`;
    await client.workflow.start(workflowWithTypeInfo, {
      workflowId,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });

    const handle = client.workflow.getHandle<typeof workflowWithTypeInfo>(workflowId, undefined, {
      typeInfo: workflowTypeInfo,
    });
    assertReceipt(t, await handle.result());
  });
});

test('same-type continue-as-new reuses definition-supplied input and output type information', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(workflowWithTypeInfo, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n, 1)],
    });

    assertReceipt(t, result);
  });
});

test('continue-as-new to a different workflow uses explicit input type information', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(continueAsNewToWorkflowWithTypeInfo, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });

    assertReceipt(t, result);
  });
});

test('signal-with-start carries definition-supplied workflow type information', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const handle = await client.workflow.signalWithStart(workflowWithSignalStart, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
      signal: finishSignal,
      signalArgs: [],
    });

    assertReceipt(t, await handle.result());
  });
});

test('update-with-start carries definition-supplied workflow type information', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const startOperation = new WithStartWorkflowOperation(workflowWithUpdateStart, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
      workflowIdConflictPolicy: 'USE_EXISTING',
    });
    await client.workflow.executeUpdateWithStart(finishUpdate, {
      startWorkflowOperation: startOperation,
    });

    assertReceipt(t, await (await startOperation.workflowHandle()).result());
  });
});

test('child workflow uses definition-supplied input and output type information', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(parentWorkflowChildDefinition, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });

    assertReceipt(t, result);
  });
});

test('child workflow uses call-site input and output type information for string workflow type', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(parentWorkflowChildString, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });

    assertReceipt(t, result);
  });
});

test('child workflow definition with call-site type information is invalid', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const err = await t.throwsAsync(
      client.workflow.execute(parentWorkflowChildDefinitionInvalidCallSiteTypeInfo, {
        workflowId: `wf-${randomUUID()}`,
        taskQueue: h.taskQueue,
        args: [new Order('order-1', 12345n)],
      }),
      { instanceOf: WorkflowFailedError }
    );

    t.regex(err?.cause?.message ?? '', /Workflow type information cannot be supplied at the call site/);
  });
});
