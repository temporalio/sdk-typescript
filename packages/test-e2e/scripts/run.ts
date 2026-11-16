import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { publishablePackages, tarballsIn } from '../../../scripts/pack-packages';
import { withRegistry } from './registry';
import { ciLogPath, shell, sleep, spawnLogged, waitOnChild } from './utils';

const packageRoot = resolve(__dirname, '..');
const repoRoot = resolve(packageRoot, '..', '..');
const npm = shell ? 'npm.cmd' : 'npm';

const publishTimeoutMs = 10 * 60_000;
const publishPollIntervalMs = 15_000;

async function main(): Promise<void> {
  const { tarballDir, sdkVersion, match } = parseArguments();
  const workdir = mkdtempSync(join(tmpdir(), 'temporal-test-e2e-'));
  // The registry runs in this process, so the tests must not block the event loop.
  const runTests = (env: NodeJS.ProcessEnv) =>
    waitOnChild(
      spawn(shell ? 'npx.cmd' : 'npx', ['ava', './lib/test-*.js', ...match.flatMap((m) => ['--match', m])], {
        cwd: packageRoot,
        env: { ...process.env, ...env },
        stdio: 'inherit',
        shell,
      })
    );

  try {
    if (tarballDir) {
      await withRegistry(join(workdir, 'registry'), async ({ file, contents }) => {
        await publishTarballs(tarballDir, contents);
        await runTests({ NPM_CONFIG_USERCONFIG: file, TEMPORAL_E2E_SDK_VERSION: sdkVersion ?? workspaceVersion() });
      });
    } else {
      const version = await waitForPublishedVersion(sdkVersion ?? workspaceVersion());
      await runTests({ TEMPORAL_E2E_SDK_VERSION: version });
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 });
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

const help = `Usage: pnpm --filter @temporalio/test-e2e run test:e2e [options]

Run the end-to-end tests: install the @temporalio/* packages into fresh projects, and run the
sample projects against them.

Packages come either from tarballs, published to a local Verdaccio registry for the duration of
the run, or from the npm registry. To pack the workspace into tarballs, run:

  pnpm bridge:collect
  pnpm packages:pack --tarball-dir <dir>

The sample projects connect to the Temporal server already listening on localhost:7233. The
hello-world-mtls sample runs against Temporal Cloud when TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE,
TEMPORAL_CLIENT_CERT and TEMPORAL_CLIENT_KEY are set (the latter two hold the PEM contents), and
is skipped otherwise. TEMPORAL_TASK_QUEUE optionally sets its task queue.

Options:
  --tarball-dir <dir>      Install the packages from the tarballs in <dir>
  --sdk-version <version>  Version of the packages to test; with no --tarball-dir, a version or dist-tag
                           on the npm registry, waiting up to ${publishTimeoutMs / 60_000} minutes for all packages
                           to be published (default: the workspace version)
  --match <pattern>        Only run the tests whose title matches <pattern> (repeatable; see \`ava --match\`)
  -h, --help               Show this help

Logs are written to $TEST_RESULTS_DIR (default: ./.test-results).
`;

function parseArguments(args = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({
      args,
      options: {
        'tarball-dir': { type: 'string' },
        'sdk-version': { type: 'string' },
        match: { type: 'string', multiple: true },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      console.log(help);
      process.exit(0);
    }

    return {
      tarballDir: values['tarball-dir'] && resolve(values['tarball-dir']),
      sdkVersion: values['sdk-version'],
      match: values.match ?? [],
    };
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

function workspaceVersion(): string {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Package sources
////////////////////////////////////////////////////////////////////////////////////////////////////

/** Publishes the tarballs in `tarballDir` to the local registry, keeping the (very noisy) output in log files. */
async function publishTarballs(tarballDir: string, npmConfig: string): Promise<void> {
  const tarballs = tarballsIn(tarballDir);
  if (tarballs.length === 0) throw new Error(`No tarballs in ${tarballDir}`);

  // `pnpm publish` ignores `[P]?NPM_CONFIG_*` env variables, so the registry config must go into
  // the workspace's own `.npmrc` while publishing.
  const npmrc = join(repoRoot, '.npmrc');
  const original = existsSync(npmrc) ? readFileSync(npmrc, 'utf8') : undefined;
  writeFileSync(npmrc, original ? `${original.replace(/\n?$/, '\n')}${npmConfig}` : npmConfig);
  try {
    for (const tarball of tarballs) {
      const name = basename(tarball, '.tgz');
      await spawnLogged(
        'pnpm',
        ['publish', tarball, '--no-git-checks', '--force'],
        { cwd: repoRoot },
        ciLogPath(`verdaccio-publish-${name}.log`),
        `Published ${name} to Verdaccio`
      );
    }
  } finally {
    if (original === undefined) rmSync(npmrc, { force: true });
    else writeFileSync(npmrc, original);
  }
}

/**
 * Resolves `spec` (a version or dist-tag) to a version of `@temporalio/create` on the npm registry, then waits
 * until every publishable package is available at that version.
 */
async function waitForPublishedVersion(spec: string): Promise<string> {
  const names = publishablePackages(repoRoot).map(({ name }) => name);
  const deadline = Date.now() + publishTimeoutMs;
  let version: string | undefined;
  for (;;) {
    version ??= npmViewVersion(`@temporalio/create@${spec}`);
    const missing =
      version === undefined
        ? [`@temporalio/create@${spec}`]
        : names.filter((name) => npmViewVersion(`${name}@${version}`) !== version).map((name) => `${name}@${version}`);
    if (missing.length === 0) {
      console.log(`Testing version ${version} from the npm registry`);
      return version!;
    }
    if (Date.now() > deadline) {
      throw new Error(`Not on the npm registry after ${publishTimeoutMs / 60_000} minutes: ${missing.join(', ')}`);
    }
    console.log(`Waiting for ${missing.join(', ')}`);
    await sleep(publishPollIntervalMs);
  }
}

function npmViewVersion(spec: string): string | undefined {
  const { status, stdout } = spawnSync(npm, ['view', spec, 'version'], { encoding: 'utf8', shell });
  if (status !== 0) return undefined;
  const versions = stdout.trim().split(/\s+/);
  if (versions.length > 1) throw new Error(`Expected a single version for ${spec}, got: ${versions.join(', ')}`);
  return versions[0] || undefined;
}

////////////////////////////////////////////////////////////////////////////////////////////////////

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
