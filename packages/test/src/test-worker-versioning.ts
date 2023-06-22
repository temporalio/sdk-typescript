/**
 * Tests the client and worker functionality for the worker versioning feature.
 *
 * @module
 */
import { v4 as uuid4 } from 'uuid';
import { WorkflowClient } from '@temporalio/client';
import { DefaultLogger, Runtime } from '@temporalio/worker';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import assert from 'assert';
import anyTest, { TestFn } from 'ava';
import * as activities from './activities';
import { unblockSignal } from './workflows';

export interface Context {
  client: WorkflowClient;
}

const test = anyTest as TestFn<Context>;

if (RUN_INTEGRATION_TESTS) {
  test.before(async (t) => {
    Runtime.install({ logger: new DefaultLogger('DEBUG') });
    t.context = {
      client: new WorkflowClient(),
    };
  });

  test('Worker versioning workers get appropriate tasks', async (t) => {
    const taskQueue = 'worker-versioning-tasks-' + uuid4();
    const wf1Id = 'worker-versioning-1-' + uuid4();
    const wf2Id = 'worker-versioning-2-' + uuid4();
    const client = t.context.client;
    await client.updateWorkerBuildIdCompatability(taskQueue, {
      operation: 'NEW_ID_IN_NEW_DEFAULT_SET',
      buildId: '1.0',
    });

    const worker1 = await Worker.create({
      workflowsPath: require.resolve('./workflows'),
      activities,
      taskQueue,
      showStackTraceSources: true,
      buildId: '1.0',
      useWorkerVersioning: true,
    });
    const worker1Prom = worker1.run();
    worker1Prom.catch((err) => {
      t.fail('Worker 1.0 run error: ' + JSON.stringify(err));
    });

    const wf1 = await client.start('unblockOrCancel', {
      taskQueue,
      workflowId: wf1Id,
    });
    await client.updateWorkerBuildIdCompatability(taskQueue, {
      operation: 'NEW_ID_IN_NEW_DEFAULT_SET',
      buildId: '2.0',
    });
    const wf2 = await client.start('unblockOrCancel', {
      taskQueue,
      workflowId: wf2Id,
    });
    await wf1.signal(unblockSignal);

    const worker2 = await Worker.create({
      workflowsPath: require.resolve('./workflows'),
      activities,
      taskQueue,
      showStackTraceSources: true,
      buildId: '2.0',
      useWorkerVersioning: true,
    });
    const worker2Prom = worker2.run();
    worker2Prom.catch((err) => {
      t.fail('Worker 2.0 run error: ' + JSON.stringify(err));
    });

    await wf2.signal(unblockSignal);

    await wf1.result();
    await wf2.result();

    worker1.shutdown();
    worker2.shutdown();
    await worker1Prom;
    await worker2Prom;
    t.pass();
  });

  test('Worker versioning client updates', async (t) => {
    const taskQueue = 'worker-versioning-client-updates-' + uuid4();
    const conn = t.context.client;

    await conn.updateWorkerBuildIdCompatability(taskQueue, {
      operation: 'NEW_ID_IN_NEW_DEFAULT_SET',
      buildId: '1.0',
    });
    let resp = await conn.getWorkerBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId(), '1.0');

    await conn.updateWorkerBuildIdCompatability(taskQueue, {
      operation: 'NEW_COMPATIBLE_VERSION',
      buildId: '1.1',
      existingCompatibleBuildId: '1.0',
    });
    resp = await conn.getWorkerBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId(), '1.1');

    // Target nonexistent build ID
    await t.throwsAsync(
      conn.updateWorkerBuildIdCompatability(taskQueue, {
        operation: 'NEW_COMPATIBLE_VERSION',
        buildId: '1.2',
        existingCompatibleBuildId: 'amnotreal',
      }),
      { message: /amnotreal not found/ }
    );

    await conn.updateWorkerBuildIdCompatability(taskQueue, {
      operation: 'PROMOTE_BUILD_ID_WITHIN_SET',
      buildId: '1.0',
    });
    resp = await conn.getWorkerBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId(), '1.0');

    await conn.updateWorkerBuildIdCompatability(taskQueue, {
      operation: 'NEW_ID_IN_NEW_DEFAULT_SET',
      buildId: '2.0',
    });
    resp = await conn.getWorkerBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId(), '2.0');

    await conn.updateWorkerBuildIdCompatability(taskQueue, {
      operation: 'PROMOTE_SET_BY_BUILD_ID',
      buildId: '1.0',
    });
    resp = await conn.getWorkerBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId(), '1.0');

    await conn.updateWorkerBuildIdCompatability(taskQueue, {
      operation: 'MERGE_SETS',
      primaryBuildId: '2.0',
      secondaryBuildId: '1.0',
    });
    resp = await conn.getWorkerBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId(), '2.0');

    t.pass();
  });
}
