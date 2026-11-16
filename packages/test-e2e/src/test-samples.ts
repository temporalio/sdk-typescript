import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'ava';
import { tempDir, testSample } from './helpers';

test.serial('sample hello-world runs against the dev server', async (t) => {
  await testSample(t, { name: 'hello-world', script: 'workflow', expectedOutput: 'Hello, Temporal!' });
});

test.serial('sample fetch-esm runs against the dev server', async (t) => {
  await testSample(t, {
    name: 'fetch-esm',
    script: 'workflow-local',
    expectedOutput: 'Hello World And Hello Wonderful Temporal!',
  });
});

const { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_CLIENT_CERT, TEMPORAL_CLIENT_KEY, TEMPORAL_TASK_QUEUE } =
  process.env;
const cloudTest =
  TEMPORAL_ADDRESS && TEMPORAL_NAMESPACE && TEMPORAL_CLIENT_CERT && TEMPORAL_CLIENT_KEY
    ? test.serial
    : test.serial.skip;

cloudTest('sample hello-world-mtls runs against Temporal Cloud', async (t) => {
  const certs = tempDir(t);
  writeFileSync(join(certs, 'client.pem'), TEMPORAL_CLIENT_CERT!);
  writeFileSync(join(certs, 'client.key'), TEMPORAL_CLIENT_KEY!);
  await testSample(t, {
    name: 'hello-world-mtls',
    script: 'workflow',
    expectedOutput: 'Hello, Temporal!',
    env: {
      TEMPORAL_ADDRESS,
      TEMPORAL_NAMESPACE,
      TEMPORAL_CLIENT_CERT_PATH: join(certs, 'client.pem'),
      TEMPORAL_CLIENT_KEY_PATH: join(certs, 'client.key'),
      TEMPORAL_TASK_QUEUE: TEMPORAL_TASK_QUEUE || `tssdk-e2e-sample-hello-world-mtls-${randomUUID()}`,
    },
  });
});
