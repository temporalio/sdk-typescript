import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'ava';
import type { ExecutionContext } from 'ava';

const dependency = import.meta.resolve('update-notifier');
const helper = new URL('./update-notifier.js', import.meta.url).href;
const pkg = { name: '@temporalio/create', version: '1.24.0' };

function runNotifier(
  t: ExecutionContext,
  options: {
    cached?: boolean;
    stale?: boolean;
    tty?: boolean;
    blockedCache?: boolean;
    invalidPackage?: boolean;
    notifyThrows?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'temporal-notifier-'));
  t.teardown(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'config');
  const npmConfig = join(directory, '.npmrc');
  writeFileSync(npmConfig, 'registry=http://127.0.0.1:1\n@temporalio:registry=http://127.0.0.1:1\n');
  const env = {
    ...process.env,
    CI: 'false',
    NODE_ENV: 'production',
    NODE_PATH: undefined,
    NO_UPDATE_NOTIFIER: undefined,
    XDG_CONFIG_HOME: config,
    NPM_CONFIG_USERCONFIG: npmConfig,
    npm_config_user_agent: 'npm/10.9.3 node/v22.19.0',
  };
  if (options.blockedCache) writeFileSync(config, 'not a directory');
  if (options.cached !== false) {
    const seed = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import updateNotifier from ${JSON.stringify(dependency)};
const notifier = updateNotifier({pkg: ${JSON.stringify(pkg)}, updateCheckInterval: Infinity});
notifier.config.set('lastUpdateCheck', Date.now() - ${options.stale ? 2 * 60 * 60 * 1000 : 0});
notifier.config.set('update', {...${JSON.stringify(pkg)}, current: '${
          pkg.version
        }', latest: '99.0.0', type: 'major'});`,
      ],
      { env, encoding: 'utf8', timeout: 5000 }
    );
    t.is(seed.status, 0, seed.stderr);
  }

  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import updateNotifier from ${JSON.stringify(dependency)};
import {createUpdateNotifier} from ${JSON.stringify(helper)};
process.stdout.isTTY = ${options.tty ?? true};
${
  options.notifyThrows
    ? `Object.getPrototypeOf(updateNotifier({pkg: ${JSON.stringify(
        pkg
      )}, updateCheckInterval: Infinity})).notify = () => {throw new Error('notification failure')};`
    : ''
}
const notify = createUpdateNotifier(${JSON.stringify(options.invalidPackage ? { name: '', version: '' } : pkg)});
notify();
console.log('CLI completed');`,
    ],
    { env: { ...env, ...options.env }, encoding: 'utf8', timeout: 5000 }
  );
}

test('cached updates are displayed during interactive npm invocations', (t) => {
  const result = runNotifier(t);
  t.is(result.status, 0, result.stderr);
  t.regex(result.stderr, /npx @temporalio\/create@latest/);
  t.regex(result.stdout, /CLI completed/);
});

test('piped output suppresses update notifications', (t) => {
  const result = runNotifier(t, { tty: false });
  t.is(result.status, 0, result.stderr);
  t.is(result.stderr, '');
});

test('fresh caches do not delay CLI completion', (t) => {
  const result = runNotifier(t, { cached: false });
  t.is(result.status, 0, result.stderr);
  t.is(result.stderr, '');
  t.regex(result.stdout, /CLI completed/);
});

test('stale caches do not wait for an unavailable registry', (t) => {
  const result = runNotifier(t, { stale: true });
  t.is(result.status, 0, result.stderr);
  t.regex(result.stdout, /CLI completed/);
});

test('the opt-out environment variable suppresses cached updates', (t) => {
  const result = runNotifier(t, { env: { NO_UPDATE_NOTIFIER: '1' } });
  t.is(result.status, 0, result.stderr);
  t.is(result.stderr, '');
});

test('CI suppresses cached updates', (t) => {
  const result = runNotifier(t, { env: { CI: 'true' } });
  t.is(result.status, 0, result.stderr);
  t.is(result.stderr, '');
});

test('an unwritable cache does not prevent CLI completion', (t) => {
  const result = runNotifier(t, { cached: false, blockedCache: true });
  t.is(result.status, 0, result.stderr);
  t.regex(result.stdout, /CLI completed/);
});

test('notifier initialization failures are nonfatal', (t) => {
  const result = runNotifier(t, { cached: false, invalidPackage: true });
  t.is(result.status, 0, result.stderr);
  t.regex(result.stdout, /CLI completed/);
});

test('notification display failures are nonfatal', (t) => {
  const result = runNotifier(t, { notifyThrows: true });
  t.is(result.status, 0, result.stderr);
  t.regex(result.stdout, /CLI completed/);
});
