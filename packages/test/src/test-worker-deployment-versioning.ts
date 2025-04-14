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
import { WorkerDeploymentVersion } from '@temporalio/common';
import { makeTestFunction } from './helpers-integration';

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
    workflowsPath: require.resolve('./workflows'),
    activities,
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: w1DeploymentVersion,
    },
  });
  const worker1Promise = worker1.run();
  worker1Promise.catch((err) => {
    t.fail('Worker 1.0 run error: ' + JSON.stringify(err));
  });

  const worker2 = await Worker.create({
    workflowsPath: require.resolve('./workflows'),
    activities,
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: w2DeploymentVersion,
    },
  });
  const worker2Promise = worker2.run();
  worker2Promise.catch((err) => {
    t.fail('Worker 2.0 run error: ' + JSON.stringify(err));
  });

  const worker3 = await Worker.create({
    workflowsPath: require.resolve('./workflows'),
    activities,
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: w3DeploymentVersion,
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
  const wf1 = await client.workflow.start('autoUpgradeWorkflow', {
    taskQueue,
    workflowId: 'basic-versioning-v1-' + randomUUID(),
  });
  const state1 = await wf1.query('state');
  assert.equal(state1, 'v1');

  // Wait for worker 2 to be visible and set as current version
  const describeResp2 = await waitUntilWorkerDeploymentVisible(client, w2DeploymentVersion);
  await setCurrentDeploymentVersion(client, describeResp2.conflictToken, w2DeploymentVersion);

  // Start workflow 2 which will use the 2.0 worker pinned
  const wf2 = await client.workflow.start('pinnedWorkflow', {
    taskQueue,
    workflowId: 'basic-versioning-v2-' + randomUUID(),
  });
  const state2 = await wf2.query('state');
  assert.equal(state2, 'v2');

  // Wait for worker 3 to be visible and set as current version
  const describeResp3 = await waitUntilWorkerDeploymentVisible(client, w3DeploymentVersion);
  await setCurrentDeploymentVersion(client, describeResp3.conflictToken, w3DeploymentVersion);

  // Start workflow 3 which will use the 3.0 worker on auto-upgrade
  const wf3 = await client.workflow.start('autoUpgradeWorkflow', {
    taskQueue,
    workflowId: 'basic-versioning-v3-' + randomUUID(),
  });
  const state3 = await wf3.query('state');
  assert.equal(state3, 'v3');

  // Signal all workflows to finish
  await wf1.signal('doFinish');
  await wf2.signal('doFinish');
  await wf3.signal('doFinish');

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

async function waitUntilWorkerDeploymentVisible(client: Client, version: WorkerDeploymentVersion) {
  return await asyncRetry(
    async () => {
      try {
        const resp = await client.workflowService.describeWorkerDeployment({
          namespace: client.options.namespace,
          deploymentName: version.deploymentName,
        });

        const isVersionVisible = resp.workerDeploymentInfo!.versionSummaries!.some(
          (vs) => vs.version === version.buildId
        );

        if (!isVersionVisible) {
          throw new Error('Version not visible yet');
        }

        return resp;
      } catch (error) {
        throw error;
      }
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
    version: version.buildId,
    conflictToken,
  });
}
