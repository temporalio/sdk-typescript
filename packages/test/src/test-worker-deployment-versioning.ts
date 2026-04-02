/**
 * Tests worker-deployment-based versioning
 *
 * @module
 */
import { randomUUID } from 'crypto';
import asyncRetry from 'async-retry';
import { ExecutionContext } from 'ava';
import { Client, WorkflowHandleWithFirstExecutionRunId } from '@temporalio/client';
import { toCanonicalString, WorkerDeploymentVersion } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { WorkerOptions } from '@temporalio/worker';
import { Worker } from './helpers';
import { Context, helpers, makeTestFunction } from './helpers-integration';
import { unblockSignal, versionQuery } from './workflows';

type WorkerDeploymentOptions = NonNullable<WorkerOptions['workerDeploymentOptions']>;

const test = makeTestFunction({ workflowsPath: __filename });

test('Worker deployment based versioning', async (t) => {
  const taskQueue = 'worker-deployment-based-versioning-' + randomUUID();
  const deploymentName = 'deployment-' + randomUUID();
  const { client, nativeConnection } = t.context.env;
  const { createNativeConnection } = helpers(t);

  const w1DeploymentVersion = {
    buildId: '1.0',
    deploymentName,
  };
  const w2DeploymentVersion = {
    buildId: '2.0',
    deploymentName,
  };
  const w3DeploymentVersion = {
    buildId: '3.0',
    deploymentName,
  };

  const worker1 = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-v1'),
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: w1DeploymentVersion,
      defaultVersioningBehavior: 'PINNED',
    },
    connection: nativeConnection,
  });
  const worker1Promise = worker1.run();
  worker1Promise.catch((err) => {
    t.fail('Worker 1.0 run error: ' + err);
  });

  const worker2Connection = await createNativeConnection();
  t.teardown(() => worker2Connection.close());
  const worker2 = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-v2'),
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: w2DeploymentVersion,
      defaultVersioningBehavior: 'PINNED',
    },
    connection: worker2Connection,
  });
  const worker2Promise = worker2.run();
  worker2Promise.catch((err) => {
    t.fail('Worker 2.0 run error: ' + err);
  });

  const worker3Connection = await createNativeConnection();
  t.teardown(() => worker3Connection.close());
  const worker3 = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-v3'),
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: w3DeploymentVersion,
      defaultVersioningBehavior: 'PINNED',
    },
    connection: worker3Connection,
  });
  const worker3Promise = worker3.run();
  worker3Promise.catch((err) => {
    t.fail('Worker 3.0 run error: ' + err);
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
  t.is(state1, 'v1');

  // Wait for worker 2 to be visible and set as current version
  const describeResp2 = await waitUntilWorkerDeploymentVisible(client, w2DeploymentVersion);
  await setCurrentDeploymentVersion(client, describeResp2.conflictToken, w2DeploymentVersion);

  // Start workflow 2 which will use the 2.0 worker pinned
  const wf2 = await client.workflow.start('deploymentVersioning', {
    taskQueue,
    workflowId: 'deployment-versioning-v2-' + randomUUID(),
  });
  const state2 = await wf2.query(versionQuery);
  t.is(state2, 'v2');

  // Wait for worker 3 to be visible and set as current version
  const describeResp3 = await waitUntilWorkerDeploymentVisible(client, w3DeploymentVersion);
  await setCurrentDeploymentVersion(client, describeResp3.conflictToken, w3DeploymentVersion);

  // Start workflow 3 which will use the 3.0 worker on auto-upgrade
  const wf3 = await client.workflow.start('deploymentVersioning', {
    taskQueue,
    workflowId: 'deployment-versioning-v3-' + randomUUID(),
  });
  const state3 = await wf3.query(versionQuery);
  t.is(state3, 'v3');

  // Signal all workflows to finish
  await wf1.signal(unblockSignal);
  await wf2.signal(unblockSignal);
  await wf3.signal(unblockSignal);

  const res1 = await wf1.result();
  const res2 = await wf2.result();
  const res3 = await wf3.result();

  t.is(res1, 'version-v3');
  t.is(res2, 'version-v2');
  t.is(res3, 'version-v3');

  worker1.shutdown();
  worker2.shutdown();
  worker3.shutdown();
  await worker1Promise;
  await worker2Promise;
  await worker3Promise;
});

test('Worker deployment based versioning with ramping', async (t) => {
  const taskQueue = 'worker-deployment-based-ramping-' + randomUUID();
  const deploymentName = 'deployment-ramping-' + randomUUID();
  const { client, nativeConnection } = t.context.env;
  const { createNativeConnection } = helpers(t);

  const v1 = {
    buildId: '1.0',
    deploymentName,
  };
  const v2 = {
    buildId: '2.0',
    deploymentName,
  };

  const worker1 = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-v1'),
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: v1,
      defaultVersioningBehavior: 'PINNED',
    },
    connection: nativeConnection,
  });
  const worker1Promise = worker1.run();
  worker1Promise.catch((err) => {
    t.fail('Worker 1.0 run error: ' + err);
  });

  const worker2Connection = await createNativeConnection();
  t.teardown(() => worker2Connection.close());
  const worker2 = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-v2'),
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: v2,
      defaultVersioningBehavior: 'PINNED',
    },
    connection: worker2Connection,
  });
  const worker2Promise = worker2.run();
  worker2Promise.catch((err) => {
    t.fail('Worker 2.0 run error: ' + err);
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
    t.is(res, 'version-v2');
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
    t.is(res, 'version-v1');
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

async function testWorkerDeploymentWithDynamicBehavior(
  t: ExecutionContext<Context>,
  workflowName: string,
  expectedResult: string
) {
  if (t.context.env.supportsTimeSkipping) {
    t.fail("Test Server doesn't support worker deployments");
    return;
  }

  const taskQueue = 'worker-deployment-dynamic-' + randomUUID();
  const deploymentName = 'deployment-dynamic-' + randomUUID();
  const { client, nativeConnection } = t.context.env;

  const version = {
    buildId: '1.0',
    deploymentName,
  };

  const worker = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-v1'),
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version,
      defaultVersioningBehavior: 'AUTO_UPGRADE',
    },
    connection: nativeConnection,
  });

  const workerPromise = worker.run();
  workerPromise.catch((err) => {
    t.fail('Worker run error: ' + err);
  });

  const describeResp = await waitUntilWorkerDeploymentVisible(client, version);
  await setCurrentDeploymentVersion(client, describeResp.conflictToken, version);

  const wf = await client.workflow.start(workflowName, {
    taskQueue,
    workflowId: 'dynamic-workflow-versioning-' + randomUUID(),
  });

  const result = await wf.result();
  t.is(result, expectedResult);

  const history = await wf.fetchHistory();
  const hasPinnedVersioningBehavior = history.events!.some(
    (event) =>
      event.workflowTaskCompletedEventAttributes &&
      event.workflowTaskCompletedEventAttributes.versioningBehavior ===
        temporal.api.enums.v1.VersioningBehavior.VERSIONING_BEHAVIOR_PINNED
  );
  t.true(hasPinnedVersioningBehavior, 'Expected workflow to use pinned versioning behavior');

  worker.shutdown();
  await workerPromise;
}

test('Worker deployment with dynamic workflow static behavior', async (t) => {
  await testWorkerDeploymentWithDynamicBehavior(t, 'cooldynamicworkflow', 'dynamic');
});

test('Worker deployment with behavior in getter', async (t) => {
  await testWorkerDeploymentWithDynamicBehavior(t, 'usesGetter', 'usesGetter');
});

test('Workflows can use default versioning behavior', async (t) => {
  const taskQueue = 'task-queue-default-versioning-' + randomUUID();
  const deploymentName = 'deployment-default-versioning-' + randomUUID();
  const { client, nativeConnection } = t.context.env;

  const workerV1 = {
    buildId: '1.0',
    deploymentName,
  };

  const worker = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-no-annotations'),
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: workerV1,
      defaultVersioningBehavior: 'PINNED',
    },
    connection: nativeConnection,
  });

  const workerPromise = worker.run();
  workerPromise.catch((err) => {
    t.fail('Worker run error: ' + err);
  });

  const describeResp = await waitUntilWorkerDeploymentVisible(client, workerV1);
  await setCurrentDeploymentVersion(client, describeResp.conflictToken, workerV1);

  const wf = await client.workflow.start('noVersioningAnnotationWorkflow', {
    taskQueue,
    workflowId: 'default-versioning-behavior-' + randomUUID(),
  });

  await wf.result();

  const history = await wf.fetchHistory();
  const hasPinnedVersioningBehavior = history.events!.some(
    (event) =>
      event.workflowTaskCompletedEventAttributes &&
      event.workflowTaskCompletedEventAttributes.versioningBehavior ===
        temporal.api.enums.v1.VersioningBehavior.VERSIONING_BEHAVIOR_PINNED
  );
  t.true(hasPinnedVersioningBehavior, 'Expected workflow to use pinned versioning behavior');

  worker.shutdown();
  await workerPromise;
});

test('Workflow versioningOverride overrides default versioning behavior', async (t) => {
  const taskQueue = 'task-queue-versioning-override-' + randomUUID();
  const { client, nativeConnection } = t.context.env;

  const workerV1 = {
    buildId: '1.0',
    deploymentName: 'deployment-versioning-override-' + randomUUID(),
  };

  const worker1 = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-v1'),
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: workerV1,
      defaultVersioningBehavior: 'AUTO_UPGRADE',
    },
    connection: nativeConnection,
  });
  const worker1Promise = worker1.run();
  worker1Promise.catch((err) => {
    t.fail('Worker 1.0 run error: ' + err);
  });

  // Wait for workers to be visible and set current version to v1
  const describeResp = await waitUntilWorkerDeploymentVisible(client, workerV1);
  await setCurrentDeploymentVersion(client, describeResp.conflictToken, workerV1);

  // Start workflow with PINNED to v1 versioningOverride - should use v1 despite AUTO_UPGRADE default
  const wfPinned = await client.workflow.start('deploymentVersioning', {
    taskQueue,
    workflowId: 'versioning-override-pinned-v1-' + randomUUID(),
    versioningOverride: {
      pinnedTo: workerV1,
    },
  });
  const statePinned = await wfPinned.query(versionQuery);
  t.is(statePinned, 'v1');

  await wfPinned.signal(unblockSignal);

  // Get results and check versioning behavior
  const historyPinned = await wfPinned.fetchHistory();
  const hasPinnedVersioningBehavior = historyPinned.events!.some(
    (event) =>
      event.workflowExecutionStartedEventAttributes?.versioningOverride?.behavior ===
        temporal.api.enums.v1.VersioningBehavior.VERSIONING_BEHAVIOR_PINNED ||
      event.workflowExecutionStartedEventAttributes?.versioningOverride?.pinned != null
  );
  t.true(hasPinnedVersioningBehavior, 'Expected workflow to use pinned versioning behavior');

  const resPinned = await wfPinned.result();
  t.is(resPinned, 'version-v1');

  worker1.shutdown();
  await worker1Promise;
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

async function waitForWorkflowRunningOnVersion(
  client: Client,
  handle: WorkflowHandleWithFirstExecutionRunId,
  expectedBuildId: string
) {
  return await asyncRetry(
    async () => {
      const desc = await client.workflowService.describeWorkflowExecution({
        namespace: client.options.namespace,
        execution: { workflowId: handle.workflowId, runId: handle.firstExecutionRunId },
      });
      const status = desc.workflowExecutionInfo?.status;
      if (status !== temporal.api.enums.v1.WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_RUNNING) {
        throw new Error(`Workflow not running yet, status: ${status}`);
      }
      const buildId = desc.workflowExecutionInfo?.versioningInfo?.deploymentVersion?.buildId;
      if (buildId !== expectedBuildId) {
        throw new Error(`Workflow on ${buildId}, expected ${expectedBuildId}`);
      }
    },
    { maxTimeout: 1000, retries: 10 }
  );
}

async function waitForRoutingConfigPropagation(
  client: Client,
  deploymentName: string,
  expectedCurrentBuildId: string,
  expectedRampingBuildId?: string
) {
  return await asyncRetry(
    async () => {
      const resp = await client.workflowService.describeWorkerDeployment({
        namespace: client.options.namespace,
        deploymentName,
      });
      const routingConfig = resp.workerDeploymentInfo?.routingConfig;
      const currentBuildId = routingConfig?.currentDeploymentVersion?.buildId;
      const rampingBuildId = routingConfig?.rampingDeploymentVersion?.buildId;

      if (currentBuildId !== expectedCurrentBuildId) {
        throw new Error(`Current version ${currentBuildId}, expected ${expectedCurrentBuildId}`);
      }
      if (rampingBuildId !== expectedRampingBuildId) {
        throw new Error(`Ramping version ${rampingBuildId}, expected ${expectedRampingBuildId}`);
      }

      const state = resp.workerDeploymentInfo?.routingConfigUpdateState;
      if (state === temporal.api.enums.v1.RoutingConfigUpdateState.ROUTING_CONFIG_UPDATE_STATE_IN_PROGRESS) {
        throw new Error('Routing config update still in progress');
      }
    },
    { maxTimeout: 1000, retries: 10 }
  );
}

test('ContinueAsNew with version upgrade', async (t) => {
  const taskQueue = 'can-version-upgrade-' + randomUUID();
  const deploymentName = 'deployment-can-' + randomUUID();
  const { client, nativeConnection } = t.context.env;
  const { createNativeConnection } = helpers(t);

  const v1 = { buildId: '1.0', deploymentName };
  const v2 = { buildId: '2.0', deploymentName };

  // Create worker v1 (pinned, with CAN logic)
  const worker1 = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-can-v1'),
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: v1,
      defaultVersioningBehavior: 'PINNED',
    },
    connection: nativeConnection,
  });
  const worker1Promise = worker1.run();
  worker1Promise.catch((err) => t.fail('Worker 1.0 error: ' + err));

  // Create worker v2 (just returns v2.0)
  const worker2Connection = await createNativeConnection();
  t.teardown(() => worker2Connection.close());
  const worker2 = await Worker.create({
    workflowsPath: require.resolve('./deployment-versioning-can-v2'),
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: true,
      version: v2,
      defaultVersioningBehavior: 'PINNED',
    },
    connection: worker2Connection,
  });
  const worker2Promise = worker2.run();
  worker2Promise.catch((err) => t.fail('Worker 2.0 error: ' + err));

  // Wait for v1, set as current
  const describeResp1 = await waitUntilWorkerDeploymentVisible(client, v1);
  const setResp1 = await setCurrentDeploymentVersion(client, describeResp1.conflictToken, v1);

  // Wait for v1 routing config to propagate
  await waitForRoutingConfigPropagation(client, deploymentName, v1.buildId);

  // Start workflow on v1
  const handle = await client.workflow.start('continueAsNewWithVersionUpgrade', {
    args: [0],
    taskQueue,
    workflowId: 'can-version-upgrade-' + randomUUID(),
  });

  // Wait for workflow to be running on v1
  await waitForWorkflowRunningOnVersion(client, handle, v1.buildId);

  // Wait for v2 to be visible, set as current
  await waitUntilWorkerDeploymentVisible(client, v2);
  await setCurrentDeploymentVersion(client, setResp1.conflictToken, v2);

  // Wait for v2 routing config to propagate
  await waitForRoutingConfigPropagation(client, deploymentName, v2.buildId);

  // Expect workflow to CAN to v2 and return 'v2.0'
  const result = await handle.result();
  t.is(result, 'v2.0');

  worker1.shutdown();
  worker2.shutdown();
  await worker1Promise;
  await worker2Promise;
});

///////////////////////////////

/**
 * Type-level tests for WorkerDeploymentOptions.
 *
 * Ensures that:
 * - When useWorkerVersioning is true, defaultVersioningBehavior is required
 * - When useWorkerVersioning is false, defaultVersioningBehavior must be absent
 * - version is always required
 */

test('Worker with deployment options and useWorkerVersioning false can run workflows', async (t) => {
  const taskQueue = 'versioning-off-with-build-id-' + randomUUID();
  const buildId = 'my-custom-build-id-1.0';
  const { client, nativeConnection } = t.context.env;

  const worker = await Worker.create({
    workflowsPath: require.resolve('./workflows'),
    taskQueue,
    workerDeploymentOptions: {
      useWorkerVersioning: false,
      version: {
        buildId,
        deploymentName: 'deployment-' + randomUUID(),
      },
    },
    connection: nativeConnection,
  });

  const handle = await client.workflow.start('successString', {
    taskQueue,
    workflowId: 'versioning-off-build-id-' + randomUUID(),
  });

  await worker.runUntil(handle.result());
  t.is(await handle.result(), 'success');

  const history = await handle.fetchHistory();
  const buildIdInHistory = history.events!.some(
    (event) => event.workflowTaskCompletedEventAttributes?.workerVersion?.buildId === buildId
  );
  t.true(buildIdInHistory, 'Expected build ID to appear in workflow history');
});

test('WorkerDeploymentOptions with useWorkerVersioning true requires defaultVersioningBehavior', (t) => {
  const valid: WorkerDeploymentOptions = {
    version: { buildId: '1.0', deploymentName: 'my-deployment' },
    useWorkerVersioning: true,
    defaultVersioningBehavior: 'AUTO_UPGRADE',
  };

  const validPinned: WorkerDeploymentOptions = {
    version: { buildId: '1.0', deploymentName: 'my-deployment' },
    useWorkerVersioning: true,
    defaultVersioningBehavior: 'PINNED',
  };

  // @ts-expect-error defaultVersioningBehavior is required when useWorkerVersioning is true
  const missingBehavior: WorkerDeploymentOptions = {
    version: { buildId: '1.0', deploymentName: 'my-deployment' },
    useWorkerVersioning: true,
  };

  t.pass();
});

test('WorkerDeploymentOptions with useWorkerVersioning false does not allow defaultVersioningBehavior', (t) => {
  const _validNoVersioning: WorkerDeploymentOptions = {
    version: { buildId: '1.0', deploymentName: 'my-deployment' },
    useWorkerVersioning: false,
  };

  const invalidWithBehavior: WorkerDeploymentOptions = {
    version: { buildId: '1.0', deploymentName: 'my-deployment' },
    useWorkerVersioning: false,
    // @ts-expect-error defaultVersioningBehavior must not be specified when useWorkerVersioning is false
    defaultVersioningBehavior: 'AUTO_UPGRADE',
  };

  t.pass();
});
