/**
 * The deterministic `crypto` shim: ADK's `randomUUID()` (interrupt ids,
 * client function-call ids, session ids) is served from a named workflow random
 * stream, so ids are well-formed and regenerate identically on replay.
 */

import test from 'ava';
import { Worker } from '@temporalio/worker';

import { GoogleAdkPlugin } from '../index';
import { REUSE_V8_CONTEXT, setupTestEnv, uid, withWorker, workflowsPath } from './helpers';
import * as activities from './test-activities';
import { cryptoShimProbe } from './workflows';

const getEnv = setupTestEnv(test);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test.serial('ADK ids are v4 UUIDs that survive a full replay', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-crypto');
  const workflowId = uid('wf-crypto');
  // The probe sends each id through an Activity, so its value is part of the
  // recorded command stream: a replay that regenerated it differently would fail
  // with a non-determinism error. The cache-disabled worker replays every task.
  const ids = await withWorker(env, { taskQueue, plugins: [new GoogleAdkPlugin()], activities }, () =>
    env.client.workflow.execute(cryptoShimProbe, { taskQueue, workflowId })
  );
  t.regex(ids.before, UUID_V4);
  t.regex(ids.after, UUID_V4);
  t.not(ids.before, ids.after);
  t.regex(ids.callId, /^adk-[0-9a-f-]{36}$/);
  await Worker.runReplayHistory(
    { workflowsPath, reuseV8Context: REUSE_V8_CONTEXT, plugins: [new GoogleAdkPlugin()] },
    await env.client.workflow.getHandle(workflowId).fetchHistory()
  );
});
