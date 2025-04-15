/**
 * Tests worker-deployment-based versioning
 *
 * @module
 */
import assert from 'assert';
import { randomUUID } from 'crypto';
import asyncRetry from 'async-retry';
import { Client } from '@temporalio/client';
import { Worker } from './helpers';
import * as activities from './activities';
import { toCanonicalString, WorkerDeploymentVersion } from '@temporalio/common';
import { makeTestFunction } from './helpers-integration';
import { unblockSignal, versionQuery } from './workflows/';
import { temporal } from '@temporalio/proto';

const test = makeTestFunction({ workflowsPath: __filename });

test('Worker deployment based versioning', async (t) => {
  const taskQueue = 'worker-deployment-based-versioning-' + randomUUID();
  const deploymentName = 'deployment-' + randomUUID();
  const client = t.context.env.client;

  const w1DeploymentVersion = {
    buildId: '1.0',
    deploymentName: deploymentName,
  };
  const w2DeploymentVersion = {
    buildId: '2.0',
    deploymentName: deploymentName,
  };
  const w3DeploymentVersion = {
    buildId: '3.0',
    deploymentName: deploymentName,
  };

  const worker1 = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-v1'),
    activities,
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: w1DeploymentVersion,
      defaultVersioningBehavior: 'pinned',
    },
  });
  const worker1Promise = worker1.run();
  worker1Promise.catch((err) => {
    t.fail('Worker 1.0 run error: ' + JSON.stringify(err));
  });

  const worker2 = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-v2'),
    activities,
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: w2DeploymentVersion,
      defaultVersioningBehavior: 'pinned',
    },
  });
  const worker2Promise = worker2.run();
  worker2Promise.catch((err) => {
    t.fail('Worker 2.0 run error: ' + JSON.stringify(err));
  });

  const worker3 = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-v3'),
    activities,
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: w3DeploymentVersion,
      defaultVersioningBehavior: 'pinned',
    },
  });
  const worker3Promise = worker3.run();
  worker3Promise.catch((err) => {
    t.fail('Worker 3.0 run error: ' + JSON.stringify(err));
  });

  // Wait for worker 1 to be visible and set as current version
  const describeResp1 = await waitUntilWorkerDeploymentVisible(client, w1DeploymentVersion);
  await setCurrentDeploymentVersion(client, describeResp1.conflictToken, w1DeploymentVersion);

  // Start workflow 1 which will use the 1.0 worker on auto-upgrade
  const wf1 = await client.workflow.start('deploymentVersioning', {
    taskQueue,
    workflowId: 'deployment-versioning-v1-' + randomUUID(),
  });
  const state1 = await wf1.query(versionQuery);
  assert.equal(state1, 'v1');

  // Wait for worker 2 to be visible and set as current version
  const describeResp2 = await waitUntilWorkerDeploymentVisible(client, w2DeploymentVersion);
  await setCurrentDeploymentVersion(client, describeResp2.conflictToken, w2DeploymentVersion);

  // Start workflow 2 which will use the 2.0 worker pinned
  const wf2 = await client.workflow.start('deploymentVersioning', {
    taskQueue,
    workflowId: 'deployment-versioning-v2-' + randomUUID(),
  });
  const state2 = await wf2.query(versionQuery);
  assert.equal(state2, 'v2');

  // Wait for worker 3 to be visible and set as current version
  const describeResp3 = await waitUntilWorkerDeploymentVisible(client, w3DeploymentVersion);
  await setCurrentDeploymentVersion(client, describeResp3.conflictToken, w3DeploymentVersion);

  // Start workflow 3 which will use the 3.0 worker on auto-upgrade
  const wf3 = await client.workflow.start('deploymentVersioning', {
    taskQueue,
    workflowId: 'deployment-versioning-v3-' + randomUUID(),
  });
  const state3 = await wf3.query(versionQuery);
  assert.equal(state3, 'v3');

  // Signal all workflows to finish
  await wf1.signal(unblockSignal);
  await wf2.signal(unblockSignal);
  await wf3.signal(unblockSignal);

  const res1 = await wf1.result();
  const res2 = await wf2.result();
  const res3 = await wf3.result();

  assert.equal(res1, 'version-v3');
  assert.equal(res2, 'version-v2');
  assert.equal(res3, 'version-v3');

  worker1.shutdown();
  worker2.shutdown();
  worker3.shutdown();
  await worker1Promise;
  await worker2Promise;
  await worker3Promise;
  t.pass();
});

test('Worker deployment based versioning with ramping', async (t) => {
  const taskQueue = 'worker-deployment-based-ramping-' + randomUUID();
  const deploymentName = 'deployment-ramping-' + randomUUID();
  const client = t.context.env.client;

  const v1 = {
    buildId: '1.0',
    deploymentName: deploymentName,
  };
  const v2 = {
    buildId: '2.0',
    deploymentName: deploymentName,
  };

  const worker1 = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-v1'),
    activities,
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: v1,
      defaultVersioningBehavior: 'pinned',
    },
  });
  const worker1Promise = worker1.run();
  worker1Promise.catch((err) => {
    t.fail('Worker 1.0 run error: ' + JSON.stringify(err));
  });

  const worker2 = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-v2'),
    activities,
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: v2,
      defaultVersioningBehavior: 'pinned',
    },
  });
  const worker2Promise = worker2.run();
  worker2Promise.catch((err) => {
    t.fail('Worker 2.0 run error: ' + JSON.stringify(err));
  });

  // Wait for worker deployments to be visible
  await waitUntilWorkerDeploymentVisible(client, v1);
  const describeResp = await waitUntilWorkerDeploymentVisible(client, v2);

  // Set current version to v1 and ramp v2 to 100%
  let conflictToken = (await setCurrentDeploymentVersion(client, describeResp.conflictToken, v1)).conflictToken;
  conflictToken = (await setRampingVersion(client, conflictToken, v2, 100)).conflictToken;

  // Run workflows and verify they run on v2
  for (let i = 0; i < 3; i++) {
    const wf = await client.workflow.start('deploymentVersioning', {
      taskQueue,
      workflowId: `versioning-ramp-100-${i}-${randomUUID()}`,
    });
    await wf.signal(unblockSignal);
    const res = await wf.result();
    assert.equal(res, 'version-v2');
  }

  // Set ramp to 0, expecting workflows to run on v1
  conflictToken = (await setRampingVersion(client, conflictToken, v2, 0)).conflictToken;
  for (let i = 0; i < 3; i++) {
    const wf = await client.workflow.start('deploymentVersioning', {
      taskQueue,
      workflowId: `versioning-ramp-0-${i}-${randomUUID()}`,
    });
    await wf.signal(unblockSignal);
    const res = await wf.result();
    assert.equal(res, 'version-v1');
  }

  // Set ramp to 50 and eventually verify workflows run on both versions
  await setRampingVersion(client, conflictToken, v2, 50);
  const seenResults = new Set<string>();

  const runAndRecord = async () => {
    const wf = await client.workflow.start('deploymentVersioning', {
      taskQueue,
      workflowId: `versioning-ramp-50-${randomUUID()}`,
    });
    await wf.signal(unblockSignal);
    return await wf.result();
  };

  await asyncRetry(
    async () => {
      const res = await runAndRecord();
      seenResults.add(res);
      if (!seenResults.has('version-v1') || !seenResults.has('version-v2')) {
        throw new Error('Not all versions seen yet');
      }
    },
    { maxTimeout: 1000, retries: 20 }
  );

  worker1.shutdown();
  worker2.shutdown();
  await worker1Promise;
  await worker2Promise;
  t.pass();
});

test('Worker deployment with dynamic workflow on run', async (t) => {
  if (t.context.env.supportsTimeSkipping) {
    t.pass("Test Server doesn't support worker deployments");
    return;
  }

  const taskQueue = 'worker-deployment-dynamic-' + randomUUID();
  const deploymentName = 'deployment-dynamic-' + randomUUID();
  const client = t.context.env.client;

  const version = {
    buildId: '1.0',
    deploymentName: deploymentName,
  };

  const worker = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-v1'),
    activities,
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: version,
      defaultVersioningBehavior: 'auto-upgrade',
    },
  });

  const workerPromise = worker.run();
  workerPromise.catch((err) => {
    t.fail('Worker run error: ' + JSON.stringify(err));
  });

  const describeResp = await waitUntilWorkerDeploymentVisible(client, version);
  await setCurrentDeploymentVersion(client, describeResp.conflictToken, version);

  const wf = await client.workflow.start('cooldynamicworkflow', {
    taskQueue,
    workflowId: 'dynamic-workflow-versioning-' + randomUUID(),
  });

  const result = await wf.result();
  assert.equal(result, 'dynamic');

  // Check history for versioning behavior
  const history = await wf.fetchHistory();

  const hasPinnedVersioningBehavior = history.events!.some(
    (event) =>
      event.workflowTaskCompletedEventAttributes &&
      event.workflowTaskCompletedEventAttributes.versioningBehavior ===
        temporal.api.enums.v1.VersioningBehavior.VERSIONING_BEHAVIOR_PINNED
  );
  assert.ok(hasPinnedVersioningBehavior, 'Expected workflow to use pinned versioning behavior');

  worker.shutdown();
  await workerPromise;
  t.pass();
});

test('Workflows can use default versioning behavior', async (t) => {
  const taskQueue = 'task-queue-default-versioning-' + randomUUID();
  const deploymentName = 'deployment-default-versioning-' + randomUUID();
  const client = t.context.env.client;

  const workerV1 = {
    buildId: '1.0',
    deploymentName: deploymentName,
  };

  const worker = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-no-annotations'),
    activities,
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: workerV1,
      defaultVersioningBehavior: 'pinned',
    },
  });

  const workerPromise = worker.run();
  workerPromise.catch((err) => {
    t.fail('Worker run error: ' + JSON.stringify(err));
  });

  const describeResp = await waitUntilWorkerDeploymentVisible(client, workerV1);
  await setCurrentDeploymentVersion(client, describeResp.conflictToken, workerV1);

  const wf = await client.workflow.start('noVersioningAnnotationWorkflow', {
    taskQueue,
    workflowId: 'default-versioning-behavior-' + randomUUID(),
  });

  await wf.result();

  // Check history for versioning behavior
  const history = await wf.fetchHistory();

  const hasPinnedVersioningBehavior = history.events!.some(
    (event) =>
      event.workflowTaskCompletedEventAttributes &&
      event.workflowTaskCompletedEventAttributes.versioningBehavior ===
        temporal.api.enums.v1.VersioningBehavior.VERSIONING_BEHAVIOR_PINNED
  );
  assert.ok(hasPinnedVersioningBehavior, 'Expected workflow to use pinned versioning behavior');

  worker.shutdown();
  await workerPromise;
  t.pass();
});

async function setRampingVersion(
  client: Client,
  conflictToken: Uint8Array,
  version: WorkerDeploymentVersion,
  percentage: number
) {
  return await client.workflowService.setWorkerDeploymentRampingVersion({
    namespace: client.options.namespace,
    deploymentName: version.deploymentName,
    version: toCanonicalString(version),
    conflictToken,
    percentage,
  });
}

async function waitUntilWorkerDeploymentVisible(client: Client, version: WorkerDeploymentVersion) {
  return await asyncRetry(
    async () => {
      const resp = await client.workflowService.describeWorkerDeployment({
        namespace: client.options.namespace,
        deploymentName: version.deploymentName,
      });
      const isVersionVisible = resp.workerDeploymentInfo!.versionSummaries!.some(
        (vs) => vs.version === toCanonicalString(version)
      );
      if (!isVersionVisible) {
        throw new Error('Version not visible yet');
      }
      return resp;
    },
    { maxTimeout: 1000, retries: 10 }
  );
}

async function setCurrentDeploymentVersion(
  client: Client,
  conflictToken: Uint8Array,
  version: WorkerDeploymentVersion
) {
  return await client.workflowService.setWorkerDeploymentCurrentVersion({
    namespace: client.options.namespace,
    deploymentName: version.deploymentName,
    version: toCanonicalString(version),
    conflictToken,
  });
}
