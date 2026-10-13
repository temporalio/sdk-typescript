import test from 'ava';
import { nexusEndpointManifest } from './nexus-endpoint-manifest';
import {
  assertNexusEndpointInManifest,
  nexusEndpointTaskQueues,
  nexusSuiteName,
  preCreatedNexusEndpointName,
} from './nexus-endpoints';

test('nexusSuiteName strips directories, availability suffixes, and extensions', (t) => {
  t.is(
    nexusSuiteName('file:///repo/packages/test/lib/test-nexus-standalone.cloud-unavailable.js'),
    'test-nexus-standalone'
  );
  t.is(nexusSuiteName('./lib/test-nexus-query-operation.js'), 'test-nexus-query-operation');
});

test('pre-created endpoint names are valid Cloud endpoint names and unique per task queue', (t) => {
  const taskQueues = nexusEndpointTaskQueues(Object.keys(nexusEndpointManifest));
  const names = taskQueues.map((taskQueue) => preCreatedNexusEndpointName('sdk-typescript-ci-1-1', taskQueue));
  for (const name of names) t.regex(name, /^[a-z][a-z0-9-]*[a-z0-9]$/);
  t.is(new Set(names).size, taskQueues.length);
});

test('no task queue appears in more than one suite', (t) => {
  const suites = Object.values(nexusEndpointManifest);
  const total = suites.reduce((count, taskQueues) => count + taskQueues.length, 0);
  t.is(nexusEndpointTaskQueues(Object.keys(nexusEndpointManifest)).length, total);
});

test('assertNexusEndpointInManifest rejects task queues missing from the manifest', (t) => {
  const [suite, taskQueues] = Object.entries(nexusEndpointManifest)[0];
  t.notThrows(() => assertNexusEndpointInManifest(`./lib/${suite}.cloud-unavailable.js`, taskQueues[0]));
  t.throws(() => assertNexusEndpointInManifest(`./lib/${suite}.js`, 'not-in-the-manifest'), {
    message: /'not-in-the-manifest' is missing from the Nexus endpoint manifest/,
  });
});
