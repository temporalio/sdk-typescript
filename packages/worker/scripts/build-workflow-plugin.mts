import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('..', import.meta.url));
const crate = path.join(worker, 'activity-reference-plugin');
const output = path.join(worker, 'lib/workflow/bundler');
const target = 'wasm32-wasip1';

const result = spawnSync('cargo', ['build', '--locked', '--release', '--target', target, '--target-dir', 'target'], {
  cwd: crate,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`cargo exited with ${result.status ?? result.signal}`);
mkdirSync(output, { recursive: true });
copyFileSync(
  path.join(crate, 'target', target, 'release', 'temporal_activity_reference_plugin.wasm'),
  path.join(output, 'activity-reference-plugin.wasm')
);
