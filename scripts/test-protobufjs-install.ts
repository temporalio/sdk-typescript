import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { getArgs, withRegistry } from './registry';
import { shell, waitOnChild } from './utils';
// eslint-disable-next-line import/order
import { version } from '../packages/client/package.json';

const packages = ['common', 'proto', 'client', 'cloud', 'worker', 'nexus', 'workflow'];
const exporter = '@opentelemetry/exporter-trace-otlp-http';

function verifyInstallation(targetDir: string): void {
  const applicationRequire = createRequire(resolve(targetDir, 'package.json'));
  const packageRequire = (name: string) => createRequire(applicationRequire.resolve(`${name}/package.json`));
  const commonRequire = packageRequire('@temporalio/common');
  const protobufPath = commonRequire.resolve('protobufjs/light');
  const protobuf = commonRequire('protobufjs/light');
  const longPath = commonRequire.resolve('long');
  const Long = commonRequire('long');

  for (const name of packages) {
    assert.equal(applicationRequire(`@temporalio/${name}/package.json`).version, version);
  }
  for (const name of packages) {
    const require = packageRequire(`@temporalio/${name}`);
    assert.equal(require.resolve('protobufjs/light'), protobufPath, `${name} must resolve the shared protobufjs`);
    assert.equal(require('protobufjs/light'), protobuf, `${name} must load the shared protobufjs runtime`);
    assert.equal(require.resolve('long'), longPath, `${name} must resolve the shared long`);
    assert.equal(require('long'), Long, `${name} must load the shared Long constructor`);
  }
  assert.equal(protobuf.util.Long, Long, 'protobufjs must use the same Long constructor as the SDK');

  // The exporter's serializer owns its protobufjs dependency. Inspect its resolution
  // without loading the exporter (or any SDK entrypoint, especially worker).
  const exporterRequire = packageRequire(exporter);
  const transformerRequire = createRequire(exporterRequire.resolve('@opentelemetry/otlp-transformer/package.json'));
  assert.match(transformerRequire('protobufjs/package.json').version, /^7\./);
  assert.notEqual(transformerRequire.resolve('protobufjs/light'), protobufPath);

  // Loading proto-utils exercises root patching and protojson against the installed
  // generated protos, not the workspace's dependency tree.
  const { historyFromJSON, historyToJSON, JSONToPayload, payloadToJSON } = commonRequire(
    '@temporalio/common/lib/proto-utils'
  );
  const eventId = '9007199254740993'; // Number.MAX_SAFE_INTEGER + 2; must not pass through a JS number.
  const payloadJSON = {
    metadata: { encoding: Buffer.from('json/plain').toString('base64') },
    data: Buffer.from('{"answer":42}').toString('base64'),
  };
  const payload = JSONToPayload(payloadJSON);
  assert.deepEqual(payloadToJSON(payload), payloadJSON);
  assert.deepEqual(JSONToPayload(payloadToJSON(payload)), payload);

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
  assert.ok(Long.isLong(history.events[0].eventId));
  assert.equal(history.events[0].eventId.toString(), eventId);
  assert.deepEqual(JSON.parse(historyToJSON(history)), historyJSON);
  assert.deepEqual(historyFromJSON(JSON.parse(historyToJSON(history))), history);
  console.log('✓ Shared protobufjs/long resolution and proto JSON round trips');
}

async function main(): Promise<void> {
  const args = await getArgs();
  const targetDir = resolve(args.targetDir);
  mkdirSync(targetDir, { recursive: true });
  // Exclusive creation prevents accidentally overwriting an existing project.
  writeFileSync(
    resolve(targetDir, 'package.json'),
    JSON.stringify({ name: 'protobufjs-install-regression', version: '1.0.0', private: true }, null, 2) + '\n',
    { flag: 'wx' }
  );

  await withRegistry(resolve(args.registryDir), targetDir, async (npmConfigFile) => {
    const install = async (dependencies: string[]) => {
      console.log(`Installing ${dependencies.join(', ')}`);
      await waitOnChild(
        spawn(shell ? 'npm.cmd' : 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...dependencies], {
          cwd: targetDir,
          env: { ...process.env, NPM_CONFIG_USERCONFIG: npmConfigFile },
          stdio: 'inherit',
          shell,
        })
      );
    };

    // Install separately to seed npm's hoist with the conflicting major first.
    await install([`${exporter}@0.57.2`]);
    const applicationRequire = createRequire(resolve(targetDir, 'package.json'));
    assert.match(applicationRequire('protobufjs/package.json').version, /^7\./, 'fixture must seed protobufjs 7');
    // No application protobufjs/long dependencies or overrides: npm must install peers.
    await install(packages.map((name) => `@temporalio/${name}@${version}`));
    verifyInstallation(targetDir);
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
