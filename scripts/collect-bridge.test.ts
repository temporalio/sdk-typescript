import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { binaryTargets, collectBinaries } from './collect-bridge.ts';

function fixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'sdk-typescript-collect-'));
  const files = {
    'artifacts/corebridge-native-linux-x64/x86_64-unknown-linux-gnu/index.node': 'linux',
    'artifacts/corebridge-native-macos-arm/aarch64-apple-darwin/index.node': 'macos',
  };
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), contents);
  }
  return root;
}

test('bridge binaries are collected from downloaded artifacts', () => {
  const root = fixture();
  const releases = resolve(root, 'releases');
  try {
    collectBinaries(resolve(root, 'artifacts'), releases);
    assert.deepEqual(binaryTargets(releases), ['aarch64-apple-darwin', 'x86_64-unknown-linux-gnu']);
    assert.equal(readFileSync(resolve(releases, 'x86_64-unknown-linux-gnu/index.node'), 'utf8'), 'linux');

    writeFileSync(resolve(root, 'artifacts/index.node'), 'stray');
    assert.throws(() => collectBinaries(resolve(root, 'artifacts'), releases), /known target/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
