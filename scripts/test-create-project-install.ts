import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getArgs, withRegistry } from './registry';
import { ciLogPath, shell } from './utils';
// eslint-disable-next-line import/order
import { version } from '../packages/create-project/package.json';

async function main(): Promise<void> {
  const args = await getArgs();
  const root = resolve(args.targetDir);
  mkdirSync(root, { recursive: true });
  mkdirSync(args.registryDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'create-install-test', private: true }), {
    flag: 'wx',
  });
  const registry = mkdtempSync(join(resolve(args.registryDir), 'create-project-'));
  const fixtures = join(root, 'fixtures');
  const archiveRoot = join(fixtures, 'samples-typescript-main');
  for (const name of ['local-sample', 'broken-sample']) {
    const directory = join(archiveRoot, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        private: true,
        scripts: name === 'broken-sample' ? { preinstall: 'node -e "process.exit(7)"' } : {},
      })
    );
    writeFileSync(join(directory, '.post-create'), 'Synthetic local sample installed.\n');
  }
  const log = ciLogPath('create-project-install.log');

  async function run(command: string, commandArgs: string[], env: NodeJS.ProcessEnv, expected = 0): Promise<string> {
    const executable = shell && ['npm', 'npx', 'pnpm'].includes(command) ? `${command}.cmd` : command;
    const child = spawn(executable, commandArgs, {
      cwd: root,
      env,
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Timed out running ${command}: ${output}`));
      }, 120_000);
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    appendFileSync(log, `$ ${command} ${commandArgs.join(' ')}\n${output}\n`);
    assert.equal(code, expected, output);
    return output;
  }

  await run('tar', ['-czf', join(fixtures, 'samples.tgz'), '-C', fixtures, 'samples-typescript-main'], process.env);
  const archive = readFileSync(join(fixtures, 'samples.tgz'));
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    if (url === '/api.github.com/repos/temporalio/samples-typescript/contents/') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(['local-sample', 'broken-sample'].map((name) => ({ name, type: 'dir' }))));
    } else if (
      /^\/api.github.com\/repos\/temporalio\/samples-typescript\/contents\/(local-sample|broken-sample)\/package.json$/.test(
        url
      ) ||
      url.startsWith('/registry.npmjs.org/@tsconfig/node')
    ) {
      response.end('{}');
    } else if (url === '/codeload.github.com/temporalio/samples-typescript/tar.gz/main') {
      response.end(archive);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    await withRegistry(registry, root, async (npmConfigFile) => {
      const env = {
        ...process.env,
        CI: 'false',
        NODE_ENV: 'production',
        NODE_PATH: undefined,
        NO_UPDATE_NOTIFIER: undefined,
        GITHUB_TOKEN: undefined,
        XDG_CONFIG_HOME: join(root, 'notifier-cache'),
        NPM_CONFIG_USERCONFIG: npmConfigFile,
        NPM_CONFIG_CACHE: join(root, 'npm-cache'),
        NPM_CONFIG_OMIT: 'dev',
        NPM_CONFIG_AUDIT: 'false',
        NPM_CONFIG_FUND: 'false',
        NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        NPM_CONFIG_IGNORE_SCRIPTS: 'false',
      };
      await run('pnpm', ['-C', resolve('packages/create-project'), 'pack', '--pack-destination', fixtures], {
        ...process.env,
        NPM_CONFIG_USERCONFIG: npmConfigFile,
      });
      const tarball = readdirSync(fixtures).find(
        (file) => file.startsWith('temporalio-create-') && file.endsWith('.tgz')
      );
      assert.ok(tarball);
      await run(
        'npm',
        ['publish', join(fixtures, tarball), '--ignore-scripts', '--registry', 'http://localhost:4873'],
        env
      );
      const preload = pathToFileURL(resolve('scripts/fixtures/create-project-network.mjs')).href;
      const cliEnv = {
        ...env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`,
        TEMPORAL_CREATE_FIXTURES_URL: `http://127.0.0.1:${address.port}`,
      };
      const npx = (commandArgs: string[], expected = 0, interactive = false) =>
        run(
          'npx',
          ['--yes', '--prefer-offline', `@temporalio/create@${version}`, ...commandArgs],
          { ...cliEnv, TEMPORAL_CREATE_TEST_TTY: interactive ? '1' : undefined },
          expected
        );
      assert.match(await npx(['--help']), /--sample/);
      assert.match(await npx(['--version']), new RegExp(version.replaceAll('.', '\\.')));
      const npxCache = join(root, 'npm-cache/_npx');
      const installed = readdirSync(npxCache)
        .map((directory) => join(npxCache, directory, 'node_modules/@temporalio/create/package.json'))
        .find((file) => existsSync(file));
      assert.ok(installed);
      const seedUpdate = () =>
        run(
          'node',
          [
            '--input-type=module',
            '-e',
            `import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require = createRequire(${JSON.stringify(installed)});
assert.throws(() => require.resolve('ava'), 'The npx installation must omit development dependencies');
const {default: updateNotifier} = await import(pathToFileURL(require.resolve('update-notifier')).href);
const notifier = updateNotifier({pkg: {name: '@temporalio/create', version: '${version}'}, updateCheckInterval: Infinity});
notifier.config.set('lastUpdateCheck', Date.now());
notifier.config.set('update', {name: '@temporalio/create', current: '${version}', latest: '99.0.0', type: 'major'});`,
          ],
          env
        );
      await seedUpdate();
      const interactive = await npx(['--list-samples'], 0, true);
      assert.match(interactive, /local-sample/);
      assert.match(interactive, /npx @temporalio\/create@latest/);
      await seedUpdate();
      const piped = await npx(['--list-samples']);
      assert.match(piped, /local-sample/);
      assert.doesNotMatch(piped, /npx @temporalio\/create@latest/);
      const project = join(root, 'created-project');
      assert.match(await npx([project, '--sample', 'local-sample', '--no-git-init']), /Success!/);
      assert.equal(JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).name, 'local-sample');
      assert.match(
        await npx([join(root, 'failed-project'), '--sample', 'broken-sample', '--no-git-init'], 1),
        /Aborting installation/
      );
      console.log('✓ Packed CLI runs through npx with production dependencies and preserves scaffolding exit codes');
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
