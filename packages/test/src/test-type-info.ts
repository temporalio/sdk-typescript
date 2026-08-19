import { randomUUID } from 'crypto';
import type { ExecutionContext } from 'ava';
import type { Info } from '@temporalio/activity';
import { firstValueFrom, ReplaySubject } from 'rxjs';
import type { WorkflowClientInterceptor, WorkflowSignalWithStartOptions } from '@temporalio/client';
import { Client, WithStartWorkflowOperation, WorkflowFailedError } from '@temporalio/client';
import { workflowInterceptorModules } from '@temporalio/testing';
import { executeChild, proxyActivities } from '@temporalio/workflow';
import type * as typeInfoActivities from './workflows/type-info/activities';
import type { TestWorkflowEnvironment } from './helpers';
import { configurableHelpers, makeTestFunction } from './helpers-integration';
import {
  parentWorkflowChildDefinition,
  parentWorkflowChildDefinitionInvalidCallSiteTypeInfo,
  continueAsNewToWorkflowWithTypeInfo,
  continueAsNewWithInterceptorTypeInfo,
  finishSignal,
  finishUpdate,
  Order,
  orderQuery,
  orderQueryTypeInfo,
  orderSignal,
  orderSignalTypeInfo,
  orderUpdate,
  parentWorkflowChildString,
  Receipt,
  signalChildTarget,
  signalChildTargetWithCallSiteTypeInfo,
  signalExternalTarget,
  signalExternalTargetWithCallSiteTypeInfo,
  signalTarget,
  queryTarget,
  updateTarget,
  workflowTypeInfo,
  workflowWithSignalStart,
  workflowWithTypeInfo,
  workflowWithUpdateStart,
  workflowWithTypedActivity,
  workflowWithTypedLocalActivity,
  workflowWithActivityWithoutTypeInfo,
  workflowWithAsyncTypedActivity,
  workflowWithDefaultTypedActivity,
  workflowWithInterceptorTypedActivity,
  workflowWithInterceptorTypedLocalActivity,
} from './workflows/type-info';
import {
  convertOrder,
  convertOrderWithoutTypeInfo,
  createAsyncOrderActivities,
} from './workflows/type-info/activities';

function assertReceipt(t: ExecutionContext, receipt: Receipt): void {
  t.true(receipt instanceof Receipt);
  t.is(receipt.summary(), `order-1:12345`);
  t.is(typeof receipt.totalCents, 'bigint');
}

const test = makeTestFunction({
  workflowsPath: require.resolve('./workflows/type-info'),
  workflowInterceptorModules: [...workflowInterceptorModules, require.resolve('./workflows/type-info/interceptors')],
});

function makeClient(env: TestWorkflowEnvironment): Client {
  return new Client({
    connection: env.client.connection,
    namespace: env.client.options.namespace,
  });
}

// Workflow executions

test('Workflow execute round-trips input and result using definition TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(workflowWithTypeInfo, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });

    assertReceipt(t, result);
  });
});

test('Workflow start and result round-trip input and result using definition TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(workflowWithTypeInfo, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });

    assertReceipt(t, await handle.result());
  });
});

test('Workflow execute uses string call-site input and output TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

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

test('Workflow start and result use string call-site input and output TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

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

test('Detached Workflow handle decodes result using call-site output TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

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

test('Workflow execute rejects call-site TypeInfo for a Workflow definition at runtime', async (t) => {
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

// Activities

test('Activity round-trips rich input and result using proxy and definition TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ activities: { convertOrder } });

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(workflowWithTypedActivity, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });
    assertReceipt(t, result);
  });
});

test('Local Activity round-trips rich input and result using proxy and definition TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ activities: { convertOrder } });

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(workflowWithTypedLocalActivity, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });
    assertReceipt(t, result);
  });
});

test('Activity uses TypeInfo supplied by an outbound interceptor', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ activities: { convertOrder } });

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(workflowWithInterceptorTypedActivity, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });
    assertReceipt(t, result);
  });
});

test('Local Activity uses TypeInfo supplied by an outbound interceptor', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ activities: { convertOrder } });

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(workflowWithInterceptorTypedLocalActivity, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });
    assertReceipt(t, result);
  });
});

test('Worker default Activity uses TypeInfo attached to the selected fallback function', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ activities: { default: convertOrder } });

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(workflowWithDefaultTypedActivity, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });
    assertReceipt(t, result);
  });
});

test('Async Activity completion by task token preserves a rich result', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const activityStarted = new ReplaySubject<Info>(1);
  const worker = await h.createWorker({ activities: createAsyncOrderActivities(activityStarted) });

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(workflowWithAsyncTypedActivity, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });
    const info = await firstValueFrom(activityStarted);
    await client.activity.complete(info.taskToken, new Receipt('order-1', 12345n), {
      typeInfo: { outputType: workflowTypeInfo.outputType },
    });
    assertReceipt(t, await handle.result());
  });
});

test('Activity without TypeInfo preserves existing best-effort conversion', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ activities: { convertOrderWithoutTypeInfo } });

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(workflowWithActivityWithoutTypeInfo, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });
    t.is(result, 'order-1');
  });
});

// Workflow transitions

test('Continue-as-new reuses definition TypeInfo for the same Workflow', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(workflowWithTypeInfo, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n, 1)],
    });

    assertReceipt(t, result);
  });
});

test('Continue-as-new uses explicit input TypeInfo for a different Workflow', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(continueAsNewToWorkflowWithTypeInfo, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });

    assertReceipt(t, result);
  });
});

test('Continue-as-new uses input TypeInfo modified by an interceptor', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(continueAsNewWithInterceptorTypeInfo, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });

    assertReceipt(t, result);
  });
});

test('Child Workflow round-trips input and result using definition TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(parentWorkflowChildDefinition, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });

    assertReceipt(t, result);
  });
});

test('Child Workflow uses string call-site input and output TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(parentWorkflowChildString, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });

    assertReceipt(t, result);
  });
});

test('Child Workflow rejects call-site TypeInfo for a Workflow definition at runtime', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

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

// Workflows started with messages

test('Signal-with-Start carries Workflow input and output TypeInfo from the definition', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

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

test('Update-with-Start carries Workflow input and output TypeInfo from the definition', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

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

// Queries

test('Client Workflow handle converts Query input and result using definition TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(queryTarget, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
    });
    assertReceipt(t, await handle.query(orderQuery, new Order('order-1', 12345n)));
    await handle.signal(finishSignal);
    await handle.result();
  });
});

test('Client Workflow handle converts string Query input and result using call-site TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(queryTarget, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
    });
    assertReceipt(
      t,
      await handle.queryWithOptions<Receipt, [Order]>('order', {
        args: [new Order('order-1', 12345n)],
        typeInfo: orderQueryTypeInfo,
      })
    );
    await handle.signal(finishSignal);
    await handle.result();
  });
});

test('Client Query interceptor can provide TypeInfo for a string Query', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = new Client({
    connection: t.context.env.client.connection,
    namespace: t.context.env.client.options.namespace,
    interceptors: {
      workflow: [
        {
          async query(input, next) {
            return await next({ ...input, typeInfo: orderQueryTypeInfo });
          },
        },
      ],
    },
  });
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(queryTarget, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
    });
    assertReceipt(
      t,
      await handle.queryWithOptions<Receipt, [Order]>('order', {
        args: [new Order('order-1', 12345n)],
      })
    );
    await handle.signal(finishSignal);
    await handle.result();
  });
});

test('Workflow Query interceptor uses output TypeInfo from the retargeted handler', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(queryTarget, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
    });
    assertReceipt(
      t,
      await handle.queryWithOptions<Receipt, [Order]>('order-alias', {
        args: [new Order('order-1', 12345n)],
        typeInfo: orderQueryTypeInfo,
      })
    );
    await handle.signal(finishSignal);
    await handle.result();
  });
});

// Updates

test('Update definition converts input and result', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(updateTarget, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
    });
    const update = await handle.startUpdate(orderUpdate, {
      args: [new Order('order-1', 12345n)],
      waitForStage: 'ACCEPTED',
    });
    assertReceipt(t, await update.result());
    await handle.result();
  });
});

test('String Update uses call-site TypeInfo for start and execute', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const startHandle = await client.workflow.start(updateTarget, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
    });
    const started = await startHandle.startUpdate<Receipt, [Order]>('order', {
      args: [new Order('order-1', 12345n)],
      waitForStage: 'ACCEPTED',
      typeInfo: workflowTypeInfo,
    });
    assertReceipt(t, await started.result());
    await startHandle.result();

    const executeHandle = await client.workflow.start(updateTarget, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
    });
    assertReceipt(
      t,
      await executeHandle.executeUpdate<Receipt, [Order]>('order', {
        args: [new Order('order-1', 12345n)],
        typeInfo: workflowTypeInfo,
      })
    );
    await executeHandle.result();
  });
});

test('Update-with-Start uses definition and string TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const definitionStart = new WithStartWorkflowOperation(updateTarget, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      workflowIdConflictPolicy: 'USE_EXISTING',
    });
    assertReceipt(
      t,
      await client.workflow.executeUpdateWithStart(orderUpdate, {
        args: [new Order('order-1', 12345n)],
        startWorkflowOperation: definitionStart,
      })
    );
    await (await definitionStart.workflowHandle()).result();

    const stringStart = new WithStartWorkflowOperation(updateTarget, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      workflowIdConflictPolicy: 'USE_EXISTING',
    });
    const update = await client.workflow.startUpdateWithStart<typeof updateTarget, Receipt, [Order]>('order', {
      args: [new Order('order-1', 12345n)],
      waitForStage: 'ACCEPTED',
      typeInfo: workflowTypeInfo,
      startWorkflowOperation: stringStart,
    });
    assertReceipt(t, await update.result());
    await (await stringStart.workflowHandle()).result();
  });
});

test('Detached Update handle decodes with call-site output TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(updateTarget, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
    });
    const update = await handle.startUpdate(orderUpdate, {
      args: [new Order('order-1', 12345n)],
      waitForStage: 'ACCEPTED',
    });
    assertReceipt(
      t,
      await handle
        .getUpdateHandle<Receipt>(update.updateId, { typeInfo: { outputType: workflowTypeInfo.outputType } })
        .result()
    );
    await handle.result();
  });
});

test('Update handle uses TypeInfo resolved by an interceptor', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const interceptor: WorkflowClientInterceptor = {
    async startUpdate(input, next) {
      return await next({ ...input, typeInfo: workflowTypeInfo });
    },
  };
  const client = new Client({
    connection: t.context.env.client.connection,
    namespace: t.context.env.client.options.namespace,
    interceptors: { workflow: [interceptor] },
  });
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(updateTarget, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
    });
    assertReceipt(t, await handle.executeUpdate('order', { args: [new Order('order-1', 12345n)] }));
    await handle.result();
  });
});

test('Update definition rejects call-site TypeInfo at runtime', async (t) => {
  const client = makeClient(t.context.env);
  const options = {
    args: [new Order('order-1', 12345n)],
    waitForStage: 'ACCEPTED' as const,
    typeInfo: workflowTypeInfo,
  } as any;
  const handle = client.workflow.getHandle('unused');
  await t.throwsAsync(handle.startUpdate(orderUpdate, options), {
    instanceOf: TypeError,
    message: /Cannot provide call-site Update TypeInfo with an Update definition/,
  });
});

// Signals

test('Client Workflow handle converts Signal input using definition TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(signalTarget, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
    });
    await handle.signal(orderSignal, new Order('order-1', 12345n));
    t.is(await handle.result(), 'order-1:12345:0');
  });
});

test('Client Workflow handle converts a string Signal using call-site TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const handle = await client.workflow.start(signalTarget, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
    });
    await handle.signalWithOptions('order', {
      args: [new Order('order-1', 12345n)],
      typeInfo: orderSignalTypeInfo,
    });
    t.is(await handle.result(), 'order-1:12345:0');
  });
});

test('Signal-with-Start converts Signal input using definition TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const handle = await client.workflow.signalWithStart(signalTarget, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      signal: orderSignal,
      signalArgs: [new Order('order-1', 12345n)],
    });
    t.is(await handle.result(), 'order-1:12345:0');
  });
});

test('Signal-with-Start converts a string Signal using call-site TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const handle = await client.workflow.signalWithStart(signalTarget, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      signal: 'order',
      signalArgs: [new Order('order-1', 12345n)],
      signalTypeInfo: orderSignalTypeInfo,
    });
    t.is(await handle.result(), 'order-1:12345:0');
  });
});

test('Signal-with-Start rejects call-site TypeInfo for a Signal definition at runtime', async (t) => {
  const client = makeClient(t.context.env);
  const options = {
    workflowId: `wf-${randomUUID()}`,
    taskQueue: 'unused',
    signal: orderSignal,
    signalArgs: [new Order('order-1', 12345n)],
    signalTypeInfo: orderSignalTypeInfo,
  } as unknown as WorkflowSignalWithStartOptions<[Order]>;

  await t.throwsAsync(client.workflow.signalWithStart(signalTarget, options), {
    instanceOf: TypeError,
    message: /Cannot provide call-site Signal TypeInfo with a Signal definition/,
  });
});

test('External Workflow handle converts Signal input using definition TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const workflowId = `wf-${randomUUID()}`;
    const target = await client.workflow.start(signalTarget, { workflowId, taskQueue: h.taskQueue });
    await client.workflow.execute(signalExternalTarget, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [workflowId],
    });
    t.is(await target.result(), 'order-1:12345:0');
  });
});

test('External Workflow handle converts a string Signal using call-site TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    const workflowId = `wf-${randomUUID()}`;
    const target = await client.workflow.start(signalTarget, { workflowId, taskQueue: h.taskQueue });
    await client.workflow.execute(signalExternalTargetWithCallSiteTypeInfo, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [workflowId],
    });
    t.is(await target.result(), 'order-1:12345:0');
  });
});

test('Child Workflow handle converts Signal input using definition TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    t.is(
      await client.workflow.execute(signalChildTarget, {
        workflowId: `wf-${randomUUID()}`,
        taskQueue: h.taskQueue,
      }),
      'order-1:12345:0'
    );
  });
});

test('Child Workflow handle converts a string Signal using call-site TypeInfo', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker();

  await worker.runUntil(async () => {
    t.is(
      await client.workflow.execute(signalChildTargetWithCallSiteTypeInfo, {
        workflowId: `wf-${randomUUID()}`,
        taskQueue: h.taskQueue,
      }),
      'order-1:12345:0'
    );
  });
});

// Compile-time contracts

// These functions are never called. The package build checks their bodies without executing SDK operations.

test('Child Workflow definitions reject call-site TypeInfo', (t) => {
  function _assertChildWorkflowTypeInfoTypes() {
    // @ts-expect-error TypeInfo must be defined on a referenced Workflow function.
    void executeChild(workflowWithTypeInfo, {
      args: [new Order('order-1', 12345n)],
      typeInfo: workflowTypeInfo,
    });
  }

  t.pass();
});

test('Signal-with-Start accepts definition, string, and union Signal references', (t) => {
  function _assertSignalWithStartReferenceTypes(client: Client, signalReference: typeof orderSignal | string) {
    void client.workflow.signalWithStart(signalTarget, {
      workflowId: 'workflow-id',
      taskQueue: 'task-queue',
      signal: orderSignal,
      signalArgs: [new Order('order-1', 12345n)],
    });

    void client.workflow.signalWithStart(signalTarget, {
      workflowId: 'workflow-id',
      taskQueue: 'task-queue',
      signal: 'order',
      signalArgs: [new Order('order-1', 12345n)],
      signalTypeInfo: orderSignalTypeInfo,
    });

    void client.workflow.signalWithStart<typeof signalTarget, [Order]>(signalTarget, {
      workflowId: 'workflow-id',
      taskQueue: 'task-queue',
      signal: signalReference,
      signalArgs: [new Order('order-1', 12345n)],
    });
  }

  t.pass();
});

test('queryWithOptions accepts only string Query names', (t) => {
  function _assertQueryWithOptionsTypes(client: Client, queryReference: typeof orderQuery | string) {
    void client.workflow.getHandle('workflow-id').queryWithOptions<Receipt, [Order]>('order', {
      args: [new Order('order-1', 12345n)],
      typeInfo: orderQueryTypeInfo,
    });

    // @ts-expect-error Call-site TypeInfo requires a Query name, not a Query definition.
    void client.workflow.getHandle('workflow-id').queryWithOptions(orderQuery, {
      args: [new Order('order-1', 12345n)],
      typeInfo: orderQueryTypeInfo,
    });

    // @ts-expect-error Call-site TypeInfo requires a Query name, not a definition-or-name union.
    void client.workflow.getHandle('workflow-id').queryWithOptions(queryReference, {
      args: [new Order('order-1', 12345n)],
      typeInfo: orderQueryTypeInfo,
    });
  }

  t.pass();
});

test('Signal-with-Start rejects call-site TypeInfo for non-string Signal references', (t) => {
  function _assertSignalWithStartTypeInfoTypes(client: Client, signalReference: typeof orderSignal | string) {
    // @ts-expect-error TypeInfo for a Signal definition must be supplied by the definition.
    void client.workflow.signalWithStart(signalTarget, {
      workflowId: 'workflow-id',
      taskQueue: 'task-queue',
      signal: orderSignal,
      signalArgs: [new Order('order-1', 12345n)],
      signalTypeInfo: orderSignalTypeInfo,
    });

    // @ts-expect-error Call-site TypeInfo requires a Signal name, not a definition-or-name union.
    void client.workflow.signalWithStart<typeof signalTarget, [Order]>(signalTarget, {
      workflowId: 'workflow-id',
      taskQueue: 'task-queue',
      signal: signalReference,
      signalArgs: [new Order('order-1', 12345n)],
      signalTypeInfo: orderSignalTypeInfo,
    });
  }

  t.pass();
});

test('Activity TypeInfo keys must name proxied Activities', (t) => {
  function _assertActivityTypeInfoKeys() {
    void proxyActivities<typeof typeInfoActivities>({
      startToCloseTimeout: '1 minute',
      activityTypeInfo: {
        convertOrder: workflowTypeInfo,
        // @ts-expect-error TypeInfo cannot be supplied for a non-Activity export.
        notAnActivity: workflowTypeInfo,
      },
    });
  }

  t.pass();
});
