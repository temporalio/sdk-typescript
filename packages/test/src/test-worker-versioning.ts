/**
 * Tests the client and worker functionality for the worker versioning feature.
 *
 * @module
 */
import assert from 'assert';
import { randomUUID } from 'crypto';
import type { ImplementationFn, TestFn } from 'ava';
import anyTest from 'ava';
import { status } from '@grpc/grpc-js';
import asyncRetry from 'async-retry';
import { BuildIdNotFoundError, Client, UnversionedBuildId } from '@temporalio/client';
import { DefaultLogger, Runtime } from '@temporalio/worker';
import { RUN_INTEGRATION_TESTS, Worker } from './helpers';
import * as activities from './activities';
import { unblockSignal } from './workflows';

export interface Context {
  client: Client;
  doSkip: boolean;
}

const test = anyTest as TestFn<Context>;
const withSkipper = test.macro<[ImplementationFn<[], Context>]>(async (t, fn) => {
  if (t.context.doSkip) {
    t.log('Skipped since this server does not support worker versioning');
    t.pass();
    return;
  }
  await fn(t);
});

if (RUN_INTEGRATION_TESTS) {
  test.before(async (t) => {
    Runtime.install({ logger: new DefaultLogger('DEBUG') });
    const client = new Client();
    // Test if this server supports worker versioning
    let doSkip = false;
    const taskQueue = 'test-worker-versioning' + randomUUID();
    try {
      await client.taskQueue.updateBuildIdCompatibility(taskQueue, {
        operation: 'addNewIdInNewDefaultSet',
        buildId: '1.0',
      });
    } catch (e: any) {
      const cause = e.cause;
      if (cause && (cause.code === status.PERMISSION_DENIED || cause.code === status.UNIMPLEMENTED)) {
        doSkip = true;
      } else {
        throw e;
      }
    }
    t.context = {
      client,
      doSkip,
    };
  });

  test('Worker versioning workers get appropriate tasks', withSkipper, async (t) => {
    const taskQueue = 'worker-versioning-tasks-' + randomUUID();
    const wf1Id = 'worker-versioning-1-' + randomUUID();
    const wf2Id = 'worker-versioning-2-' + randomUUID();
    const client = t.context.client;
    await client.taskQueue.updateBuildIdCompatibility(taskQueue, {
      operation: 'addNewIdInNewDefaultSet',
      buildId: '1.0',
    });

    const worker1 = await Worker.create({
      workflowsPath: require.resolve('./workflows'),
      activities,
      taskQueue,
      buildId: '1.0',
      useVersioning: true,
    });
    const worker1Prom = worker1.run();
    worker1Prom.catch((err) => {
      t.fail('Worker 1.0 run error: ' + JSON.stringify(err));
    });

    const wf1 = await client.workflow.start('unblockOrCancel', {
      taskQueue,
      workflowId: wf1Id,
    });
    await client.taskQueue.updateBuildIdCompatibility(taskQueue, {
      operation: 'addNewIdInNewDefaultSet',
      buildId: '2.0',
    });
    const wf2 = await client.workflow.start('unblockOrCancel', {
      taskQueue,
      workflowId: wf2Id,
    });
    await wf1.signal(unblockSignal);

    const worker2 = await Worker.create({
      workflowsPath: require.resolve('./workflows'),
      activities,
      taskQueue,
      buildId: '2.0',
      useVersioning: true,
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

  test('Worker versioning client updates', withSkipper, async (t) => {
    const taskQueue = 'worker-versioning-client-updates-' + randomUUID();
    const conn = t.context.client;

    await conn.taskQueue.updateBuildIdCompatibility(taskQueue, {
      operation: 'addNewIdInNewDefaultSet',
      buildId: '1.0',
    });
    let resp = await conn.taskQueue.getBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId, '1.0');

    await conn.taskQueue.updateBuildIdCompatibility(taskQueue, {
      operation: 'addNewCompatibleVersion',
      buildId: '1.1',
      existingCompatibleBuildId: '1.0',
    });
    resp = await conn.taskQueue.getBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId, '1.1');

    // Target nonexistent build ID
    await t.throwsAsync(
      conn.taskQueue.updateBuildIdCompatibility(taskQueue, {
        operation: 'addNewCompatibleVersion',
        buildId: '1.2',
        existingCompatibleBuildId: 'amnotreal',
      }),
      { message: /amnotreal not found/, instanceOf: BuildIdNotFoundError }
    );

    await conn.taskQueue.updateBuildIdCompatibility(taskQueue, {
      operation: 'promoteBuildIdWithinSet',
      buildId: '1.0',
    });
    resp = await conn.taskQueue.getBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId, '1.0');

    await conn.taskQueue.updateBuildIdCompatibility(taskQueue, {
      operation: 'addNewIdInNewDefaultSet',
      buildId: '2.0',
    });
    resp = await conn.taskQueue.getBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId, '2.0');

    await conn.taskQueue.updateBuildIdCompatibility(taskQueue, {
      operation: 'promoteSetByBuildId',
      buildId: '1.0',
    });
    resp = await conn.taskQueue.getBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId, '1.0');

    await conn.taskQueue.updateBuildIdCompatibility(taskQueue, {
      operation: 'mergeSets',
      primaryBuildId: '2.0',
      secondaryBuildId: '1.0',
    });
    resp = await conn.taskQueue.getBuildIdCompatability(taskQueue);
    assert.equal(resp?.defaultBuildId, '2.0');

    await asyncRetry(
      async () => {
        const reachResp = await conn.taskQueue.getReachability({ buildIds: ['2.0', '1.0', '1.1'] });
        assert.deepEqual(reachResp.buildIdReachability['2.0']?.taskQueueReachability[taskQueue], ['NEW_WORKFLOWS']);
        assert.deepEqual(reachResp.buildIdReachability['1.1']?.taskQueueReachability[taskQueue], []);
        assert.deepEqual(reachResp.buildIdReachability['1.0']?.taskQueueReachability[taskQueue], []);
      },
      { maxTimeout: 1000 }
    );
    await asyncRetry(
      async () => {
        const reachResp = await conn.taskQueue.getReachability({
          buildIds: [UnversionedBuildId],
          taskQueues: [taskQueue],
        });
        assert.deepEqual(reachResp.buildIdReachability[UnversionedBuildId]?.taskQueueReachability[taskQueue], [
          'NEW_WORKFLOWS',
        ]);
      },
      { maxTimeout: 1000 }
    );

    t.pass();
  });
}
