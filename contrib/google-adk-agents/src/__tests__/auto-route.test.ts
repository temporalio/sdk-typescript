/**
 * Model auto-routing: inside a Workflow, ADK's built-in model patterns resolve
 * to `TemporalModel`, so vanilla ADK code with a raw model string is durable.
 */

import test from 'ava';

import { GoogleAdkPlugin } from '../index';
import { countScheduledActivities, defaultTestProvider, setupTestEnv, uid, withWorker } from './helpers';
import { rawModelStringAgent, registryResolveProbe, routedLlmAgent } from './graph-workflows';

const getEnv = setupTestEnv(test);

function makePlugin(autoRouteModels?: boolean): GoogleAdkPlugin {
  return new GoogleAdkPlugin({ modelProvider: defaultTestProvider(), autoRouteModels });
}

test.serial('a raw Gemini model string runs through the model Activity', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-route-gemini');
  const workflowId = uid('wf-route-gemini');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(rawModelStringAgent, { taskQueue, workflowId, args: ['gemini-2.5-flash'] })
  );
  t.is(result.text, 'fake-response:gemini-2.5-flash');
  t.is(result.errorMessage, undefined);
  const { events } = await env.client.workflow.getHandle(workflowId).fetchHistory();
  t.is(countScheduledActivities(events ?? [], 'adk-invokeModel'), 1);
});

test.serial('a raw Apigee model string runs through the model Activity too', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-route-apigee');
  const result = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(rawModelStringAgent, {
      taskQueue,
      workflowId: uid('wf-route-apigee'),
      args: ['apigee/gemini-2.5-flash'],
    })
  );
  t.is(result.text, 'fake-response:apigee/gemini-2.5-flash');
});

test.serial('the sandbox registry resolves every built-in pattern to the Temporal model class', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-route-registry');
  const probe = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(registryResolveProbe, { taskQueue, workflowId: uid('wf-route-registry') })
  );
  t.is(probe.gemini, 'AutoRoutedTemporalModel');
  t.is(probe.apigee, 'AutoRoutedTemporalModel');
  t.false(probe.apigeeIsBuiltIn);
});

test.serial('RoutedLlm routes between TemporalModel instances', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-route-routed');
  const text = await withWorker(env, { taskQueue, plugins: [makePlugin()] }, () =>
    env.client.workflow.execute(routedLlmAgent, { taskQueue, workflowId: uid('wf-route-routed'), args: ['b'] })
  );
  t.is(text, 'fake-response:fake-b');
});

test.serial('autoRouteModels: false leaves the built-in classes registered in the sandbox', async (t) => {
  const env = getEnv();
  const taskQueue = uid('adk-route-off');
  // Only the registry is probed: with the real Gemini class resolving inside the
  // sandbox, an actual model call cannot reach the network and its retry backoff
  // becomes durable timers, so that path is the documented misconfiguration, not
  // something to await in a test.
  const probe = await withWorker(env, { taskQueue, plugins: [makePlugin(false)] }, () =>
    env.client.workflow.execute(registryResolveProbe, { taskQueue, workflowId: uid('wf-route-off') })
  );
  t.is(probe.gemini, 'Gemini');
  t.is(probe.apigee, 'ApigeeLlm');
  t.true(probe.apigeeIsBuiltIn);
});
