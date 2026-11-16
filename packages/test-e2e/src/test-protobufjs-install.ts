import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test, { type ExecutionContext } from 'ava';
import { npm, sdkVersion as version, tempDir } from './helpers';

const packages = ['common', 'proto', 'client', 'cloud', 'worker', 'nexus', 'workflow'];
const exporter = '@opentelemetry/exporter-trace-otlp-http';

function createProject(t: ExecutionContext): string {
  const dir = tempDir(t);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'temporal-test-e2e', version: '1.0.0', private: true }, null, 2) + '\n'
  );
  return dir;
}

async function npmInstall(dir: string, dependencies: string[]): Promise<void> {
  const child = spawn(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...dependencies], {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`npm install exited with ${signal ?? code}`))
    );
  });
}

test('npm installs one protobufjs and long shared by the SDK packages', async (t) => {
  const dir = createProject(t);

  // Install separately to seed npm's hoist with the conflicting major first.
  await npmInstall(dir, [`${exporter}@0.57.2`]);
  const applicationRequire = createRequire(join(dir, 'package.json'));
  t.regex(applicationRequire('protobufjs/package.json').version, /^7\./, 'fixture must seed protobufjs 7');
  // No application protobufjs/long dependencies or overrides: npm must install peers.
  await npmInstall(
    dir,
    packages.map((name) => `@temporalio/${name}@${version}`)
  );

  const packageRequire = (name: string) => createRequire(applicationRequire.resolve(`${name}/package.json`));
  const commonRequire = packageRequire('@temporalio/common');
  const protobufPath = commonRequire.resolve('protobufjs/light');
  const protobuf = commonRequire('protobufjs/light');
  const longPath = commonRequire.resolve('long');
  const Long = commonRequire('long');

  for (const name of packages) {
    t.is(applicationRequire(`@temporalio/${name}/package.json`).version, version);
  }
  for (const name of packages) {
    const require = packageRequire(`@temporalio/${name}`);
    t.is(require.resolve('protobufjs/light'), protobufPath, `${name} must resolve the shared protobufjs`);
    t.is(require('protobufjs/light'), protobuf, `${name} must load the shared protobufjs runtime`);
    t.is(require.resolve('long'), longPath, `${name} must resolve the shared long`);
    t.is(require('long'), Long, `${name} must load the shared Long constructor`);
  }
  t.is(protobuf.util.Long, Long, 'protobufjs must use the same Long constructor as the SDK');

  // The exporter's serializer owns its protobufjs dependency. Inspect its resolution
  // without loading the exporter (or any SDK entrypoint, especially worker).
  const exporterRequire = packageRequire(exporter);
  const transformerRequire = createRequire(exporterRequire.resolve('@opentelemetry/otlp-transformer/package.json'));
  t.regex(transformerRequire('protobufjs/package.json').version, /^7\./);
  t.not(transformerRequire.resolve('protobufjs/light'), protobufPath);

  // Loading proto-utils exercises root patching and protojson against the installed
  // generated protos, not the workspace's dependency tree.
  const { historyFromJSON, historyToJSON, JSONToPayload, payloadToJSON } = commonRequire(
    '@temporalio/common/proto-utils'
  );
  const eventId = '9007199254740993'; // Number.MAX_SAFE_INTEGER + 2; must not pass through a JS number.
  const payloadJSON = {
    metadata: { encoding: Buffer.from('json/plain').toString('base64') },
    data: Buffer.from('{"answer":42}').toString('base64'),
  };
  const payload = JSONToPayload(payloadJSON);
  t.deepEqual(payloadToJSON(payload), payloadJSON);
  t.deepEqual(JSONToPayload(payloadToJSON(payload)), payload);

  const historyJSON = {
    events: [
      {
        eventId,
        eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED',
        workflowExecutionCompletedEventAttributes: {
          result: { payloads: [payloadJSON] },
          workflowTaskCompletedEventId: eventId,
        },
      },
    ],
  };
  const history = historyFromJSON(historyJSON);
  t.true(Long.isLong(history.events[0].eventId));
  t.is(history.events[0].eventId.toString(), eventId);
  t.deepEqual(JSON.parse(historyToJSON(history)), historyJSON);
  t.deepEqual(historyFromJSON(JSON.parse(historyToJSON(history))), history);
});
