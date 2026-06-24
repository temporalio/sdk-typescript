import { setTimeout as setTimeoutPromise } from 'timers/promises';
import { randomUUID } from 'crypto';
import * as workflow from '@temporalio/workflow';
import type { SearchAttributePair } from '@temporalio/common';
import {
  defineSearchAttributeKey,
  encodingKeys,
  METADATA_ENCODING_KEY,
  RawValue,
  SearchAttributeType,
  TypedSearchAttributes,
} from '@temporalio/common';
import { encode } from '@temporalio/common/lib/encoding';
import {
  buildIdTester,
  completableWorkflow,
  getBuildIdQuery,
  historySizeGrows,
  queryWorkflowMetadata,
  rawValueWorkflow,
  rootWorkflow,
  suggestedCAN,
  unblockSignal,
  upsertAndReadMemo,
  WithChildWorkflow,
  WorkflowWillFail,
} from './test-integration-workflows-common';
import { createLocalTestEnvironment, helpers, makeTestFunction } from './helpers-integration';
import { waitUntil } from './helpers';

export * from './test-integration-workflows-common';

const test = makeTestFunction({
  workflowsPath: __filename,
  workflowInterceptorModules: [__filename],
});

test('HistorySize grows with new WFT', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  const [before, after] = await worker.runUntil(executeWorkflow(historySizeGrows));
  t.true(after > before && before > 100);
});

test('HistorySize is visible in WorkflowExecutionInfo', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  const handle = await startWorkflow(historySizeGrows);

  await worker.runUntil(handle.result());
  const historySize = (await handle.describe()).historySize;
  t.true(historySize && historySize > 100);
});

test('ContinueAsNew is suggested', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  const flaggedCAN = await worker.runUntil(executeWorkflow(suggestedCAN));
  t.true(flaggedCAN);
});

test('Query workflow metadata returns handler descriptions', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);

  const worker = await createWorker();

  await worker.runUntil(async () => {
    const handle = await startWorkflow(queryWorkflowMetadata);
    const meta = await handle.query(workflow.workflowMetadataQuery);
    t.is(meta.definition?.type, 'queryWorkflowMetadata');
    const queryDefinitions = meta.definition?.queryDefinitions;
    // Three built-in ones plus dummyQuery1 and dummyQuery2
    t.is(queryDefinitions?.length, 5);
    t.deepEqual(queryDefinitions?.[3], { name: 'dummyQuery1', description: 'query1' });
    t.deepEqual(queryDefinitions?.[4], { name: 'dummyQuery2', description: 'query2' });
    const signalDefinitions = meta.definition?.signalDefinitions;
    t.deepEqual(signalDefinitions, [{ name: 'dummySignal1', description: 'signal1' }]);
    const updateDefinitions = meta.definition?.updateDefinitions;
    t.deepEqual(updateDefinitions, [{ name: 'dummyUpdate1', description: 'update1' }]);
  });
});

test('Build Id appropriately set in workflow info', async (t) => {
  const { taskQueue, createWorker } = helpers(t);
  const wfid = `${taskQueue}-` + randomUUID();
  const client = t.context.env.client;

  const worker1 = await createWorker({ buildId: '1.0' });
  await worker1.runUntil(async () => {
    const handle = await client.workflow.start(buildIdTester, {
      taskQueue,
      workflowId: wfid,
    });
    t.is(await handle.query(getBuildIdQuery), '1.0');
  });

  await client.workflowService.resetStickyTaskQueue({
    namespace: worker1.options.namespace,
    execution: { workflowId: wfid },
  });

  const worker2 = await createWorker({ buildId: '1.1' });
  await worker2.runUntil(async () => {
    const handle = await client.workflow.getHandle(wfid);
    t.is(await handle.query(getBuildIdQuery), '1.0');
    await handle.signal(unblockSignal);
    t.is(await handle.query(getBuildIdQuery), '1.1');
  });
});

test('Workflow can upsert memo', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const handle = await startWorkflow(upsertAndReadMemo, {
      memo: {
        alpha: 'bar1',
        bravo: 'bar3',
        charlie: { delta: 'bar2', echo: 12 },
        foxtrot: 'bar4',
      },
      args: [
        {
          alpha: 'bar11',
          bravo: null,
          charlie: { echo: 34, golf: 'bar5' },
          hotel: 'bar6',
        },
      ],
    });
    const result = await handle.result();
    t.deepEqual(result, {
      alpha: 'bar11',
      charlie: { echo: 34, golf: 'bar5' },
      foxtrot: 'bar4',
      hotel: 'bar6',
    });
    const { memo } = await handle.describe();
    t.deepEqual(memo, {
      alpha: 'bar11',
      charlie: { echo: 34, golf: 'bar5' },
      foxtrot: 'bar4',
      hotel: 'bar6',
    });
  });
});

test("WorkflowInfo().lastFailure contains last run's failure on Workflow Failure", async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();
  const handle = await startWorkflow(WorkflowWillFail, { retry: { maximumAttempts: 2 } });
  await worker.runUntil(async () => {
    const lastFailure = await handle.result();
    t.is(lastFailure, 'WorkflowWillFail');
  });
});

test('Count workflow executions', async (t) => {
  const { taskQueue, createWorker, executeWorkflow, startWorkflow } = helpers(t);
  const worker = await createWorker();
  const client = t.context.env.client;

  await worker.runUntil(async () => {
    await Promise.all([
      // Run 2 workflows that will never complete...
      startWorkflow(completableWorkflow, { args: [false] }),
      startWorkflow(completableWorkflow, { args: [false] }),

      // ... and 3 workflows that will complete
      executeWorkflow(completableWorkflow, { args: [true] }),
      executeWorkflow(completableWorkflow, { args: [true] }),
      executeWorkflow(completableWorkflow, { args: [true] }),
    ]);
  });

  // FIXME: Find a better way to wait for visibility to stabilize
  await setTimeoutPromise(1000);

  const actualTotal = await client.workflow.count(`TaskQueue = '${taskQueue}'`);
  t.deepEqual(actualTotal, { count: 5, groups: [] });

  const actualByExecutionStatus = await client.workflow.count(`TaskQueue = '${taskQueue}' GROUP BY ExecutionStatus`);
  t.deepEqual(actualByExecutionStatus, {
    count: 5,
    groups: [
      { count: 2, groupValues: [['Running']] },
      { count: 3, groupValues: [['Completed']] },
    ],
  });
});

test.serial('can register search attributes to dev server', async (t) => {
  const key = defineSearchAttributeKey('new-search-attr', SearchAttributeType.INT);
  const newSearchAttribute: SearchAttributePair = { key, value: 12 };

  // Create new test environment with search attribute registered.
  const env = await createLocalTestEnvironment({
    server: {
      searchAttributes: [key],
    },
  });

  const newClient = env.client;
  // Expect workflow with search attribute to start without error.
  const handle = await newClient.workflow.start(completableWorkflow, {
    args: [true],
    workflowId: randomUUID(),
    taskQueue: 'new-env-tq',
    typedSearchAttributes: [newSearchAttribute],
  });
  // Expect workflow description to have search attribute.
  const desc = await handle.describe();
  t.deepEqual(desc.typedSearchAttributes, new TypedSearchAttributes([newSearchAttribute]));
  t.deepEqual(desc.searchAttributes, { 'new-search-attr': [12] });
  await env.teardown();
});

test('workflow and activity can receive/return RawValue', async (t) => {
  const { executeWorkflow, createWorker } = helpers(t);
  const worker = await createWorker({
    activities: {
      async rawValueActivity(value: unknown, isPayload: boolean = false): Promise<RawValue> {
        const rv = isPayload
          ? RawValue.fromPayload({
              metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_RAW },
              data: value as Uint8Array,
            })
          : new RawValue(value);
        return rv;
      },
    },
  });

  await worker.runUntil(async () => {
    const testValue = 'test';
    const rawValue = new RawValue(testValue);
    const rawValuePayload = RawValue.fromPayload({
      metadata: { [METADATA_ENCODING_KEY]: encodingKeys.METADATA_ENCODING_RAW },
      data: encode(testValue),
    });
    const res = await executeWorkflow(rawValueWorkflow, {
      args: [rawValue],
    });
    t.deepEqual(res, testValue);
    const res2 = await executeWorkflow(rawValueWorkflow, {
      args: [rawValuePayload, true],
    });
    t.deepEqual(res2, encode(testValue));
  });
});

test('root execution is exposed', async (t) => {
  const { createWorker, startWorkflow } = helpers(t);
  const worker = await createWorker();

  await worker.runUntil(async () => {
    const childWfId = 'child-wf-id';
    const handle = await startWorkflow(WithChildWorkflow, {
      args: [childWfId],
    });

    const childHandle = t.context.env.client.workflow.getHandle(childWfId);
    const childStarted = async (): Promise<boolean> => {
      try {
        await childHandle.describe();
        return true;
      } catch (e) {
        if (e instanceof workflow.WorkflowNotFoundError) {
          return false;
        } else {
          throw e;
        }
      }
    };
    await waitUntil(childStarted, 12000);
    const childDesc = await childHandle.describe();
    const parentDesc = await handle.describe();

    t.true(childDesc.rootExecution?.workflowId === parentDesc.workflowId);
    t.true(childDesc.rootExecution?.runId === parentDesc.runId);

    await childHandle.signal(unblockSignal);
    const childWfInfoRoot = await handle.result();
    t.true(childWfInfoRoot?.workflowId === parentDesc.workflowId);
    t.true(childWfInfoRoot?.runId === parentDesc.runId);
  });
});

test('Workflow can return root workflow', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);
  const worker = await createWorker();
  await worker.runUntil(async () => {
    const result = await executeWorkflow(rootWorkflow, { workflowId: 'test-root-workflow-length' });
    t.deepEqual(result, 'empty test-root-workflow-length');
  });
});
