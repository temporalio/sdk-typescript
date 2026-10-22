import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  gitBlobSha,
  githubClient,
  inspectPullRequest,
  paginate,
  publicationTimes,
  publishReport,
} from './dependency-cooldown.mjs';
import { parseLockfile, parsePolicy } from './dependency-cooldown-policy.mjs';

const repository = 'temporalio/sdk-typescript';
const headSha = '1'.repeat(40);
const baseSha = '2'.repeat(40);
const now = Date.parse('2026-10-06T15:52:23Z');
const workspaceText = 'minimumReleaseAge: 20160\n';
const pnpm = (identities) =>
  `lockfileVersion: '9.0'\npackages:\n${identities.map((name) => `  '${name}': {}\n`).join('')}`;
const baseLockfiles = new Map([['pnpm-lock.yaml', pnpm(['express-rate-limit@8.3.0'])]]);
const packageNames = ['@modelcontextprotocol/sdk@1.31.0', 'express-rate-limit@8.7.1'];
const releaseDates = {
  '@modelcontextprotocol/sdk': { '1.31.0': '2026-09-28T18:59:36.307Z' },
  'express-rate-limit': { '8.7.1': '2026-10-06T02:04:46.635Z' },
};

function fixture({
  extraFiles = [],
  contents = pnpm(packageNames),
  pull = {},
  latePull = {},
  blob = {},
  headTree,
  truncated = false,
  ancestry = 'ahead',
  extraLockfiles = new Map(),
} = {}) {
  const requests = [];
  const locks = new Map([['pnpm-lock.yaml', contents], ...extraLockfiles]);
  const tree = [...locks].map(([path, text]) => ({ path, type: 'blob', mode: '100644', sha: gitBlobSha(text) }));
  tree.push(
    ...extraFiles.map(({ filename }) => ({ path: filename, type: 'blob', mode: '100644', sha: '5'.repeat(40) }))
  );
  let pullReads = 0;
  const github = async (path) => {
    requests.push(path);
    if (path === `repos/${repository}/pulls/2492`) {
      pullReads++;
      return {
        head: { sha: headSha },
        base: { ref: 'main', sha: baseSha, repo: { full_name: repository } },
        ...pull,
        ...(pullReads > 1 ? latePull : {}),
      };
    }
    if (path.includes('/compare/')) return { status: ancestry };
    if (path.includes(`/git/trees/${baseSha}`))
      return {
        truncated: false,
        tree: [...baseLockfiles].map(([path, text]) => ({ path, type: 'blob', mode: '100644', sha: gitBlobSha(text) })),
      };
    if (path.includes(`/git/trees/${headSha}`)) return { truncated, tree: headTree ?? tree };
    for (const text of locks.values()) {
      if (path.endsWith(`/git/blobs/${gitBlobSha(text)}`))
        return {
          encoding: 'base64',
          content: Buffer.from(text).toString('base64'),
          ...blob,
        };
    }
    throw new Error(`Unexpected GitHub request: ${path}`);
  };
  const registryRequests = [];
  const registryFetch = async (url, options) => {
    registryRequests.push({ url, options });
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    return { ok: true, json: async () => ({ time: releaseDates[name] }) };
  };
  return { github, registryFetch, requests, registryRequests };
}

const options = {
  repository,
  number: 2492,
  headSha,
  baseSha,
  baseRef: 'main',
  baseLockfiles,
  workspaceText,
  exceptionsText: '{"exceptions":[]}',
  now,
};

test('security-update-style lock diff does not get a blanket bypass', async () => {
  const mocks = fixture();
  const { result, report } = await inspectPullRequest({ ...options, ...mocks });
  assert.equal(result.blocked.length, 2);
  assert.equal(result.allowed.length, 0);
  assert.match(report, /BLOCKED/);
  assert.ok(mocks.registryRequests.every(({ options }) => !options.headers.authorization));
  assert.ok(mocks.requests.every((path) => !path.includes('/files?')));
});

test('a trusted exact exception allows only the fix, not its collateral refresh', async () => {
  const mocks = fixture({
    extraFiles: [{ filename: '.github/dependency-cooldown-exceptions.json', status: 'modified' }],
  });
  const exceptionsText = JSON.stringify({
    exceptions: [
      {
        package: '@modelcontextprotocol/sdk',
        version: '1.31.0',
        reason: 'Minimum fixed version for OAuth credential disclosure',
        advisory: 'GHSA-6qxp-vccf-f47h',
      },
    ],
  });
  const { result } = await inspectPullRequest({ ...options, ...mocks, exceptionsText });
  assert.equal(result.allowed.length, 1);
  assert.equal(result.blocked[0].name, 'express-rate-limit');
  // Never read a PR's exception file, even when that file is changed in the PR.
  assert.ok(mocks.requests.every((path) => !path.includes('/contents/.github/')));
});

test('existing base versions are grandfathered without any registry lookup', async () => {
  const mocks = fixture({ contents: pnpm(['express-rate-limit@8.3.0']) });
  const { result } = await inspectPullRequest({ ...options, ...mocks });
  assert.equal(result.checked, 0);
  assert.equal(mocks.registryRequests.length, 0);
});

test('unrelated PRs and removed lockfiles require no registry lookup', async () => {
  for (const headTree of [[{ path: 'README.md', type: 'blob', mode: '100644', sha: '5'.repeat(40) }], []]) {
    const mocks = fixture({ headTree });
    const { result } = await inspectPullRequest({ ...options, ...mocks });
    assert.equal(result.checked, 0);
    assert.equal(mocks.registryRequests.length, 0);
  }
});

test('changed head/base and invalid identities fail closed', async () => {
  for (const pull of [
    { head: { sha: '3'.repeat(40) } },
    { base: { ref: 'release', sha: baseSha, repo: { full_name: repository } } },
    { base: { ref: 'main', sha: '3'.repeat(40), repo: { full_name: repository } } },
    { base: { ref: 'main', sha: baseSha, repo: { full_name: 'other/repo' } } },
  ])
    await assert.rejects(inspectPullRequest({ ...options, ...fixture({ pull }) }));
  await assert.rejects(inspectPullRequest({ ...options, ...fixture(), headSha: '../../main' }));
  await assert.rejects(inspectPullRequest({ ...options, ...fixture(), number: NaN }));
});

test('immutable trees, blob hashes, symlinks and size bounds fail closed', async () => {
  await assert.rejects(inspectPullRequest({ ...options, ...fixture({ truncated: true }) }));
  await assert.rejects(
    inspectPullRequest({
      ...options,
      ...fixture({ headTree: [{ path: 'pnpm-lock.yaml', type: 'blob', mode: '120000', sha: '5'.repeat(40) }] }),
    })
  );
  for (const blob of [{ encoding: 'none' }, { content: Buffer.from('wrong blob').toString('base64') }]) {
    await assert.rejects(inspectPullRequest({ ...options, ...fixture({ blob }) }));
  }
  await assert.rejects(inspectPullRequest({ ...options, ...fixture({ contents: 'x'.repeat(11 * 1024 * 1024) }) }));
  await assert.rejects(inspectPullRequest({ ...options, ...fixture({ contents: 'not a lockfile' }) }));
  await assert.rejects(inspectPullRequest({ ...options, ...fixture(), baseLockfiles: new Map() }));
  await assert.rejects(inspectPullRequest({ ...options, ...fixture({ ancestry: 'diverged' }) }));
});

test('npm shrinkwrap is audited even when package-lock is absent', async () => {
  const shrinkwrap = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      'node_modules/express-rate-limit': { version: '8.7.1' },
    },
  });
  const mocks = fixture({
    contents: baseLockfiles.get('pnpm-lock.yaml'),
    extraLockfiles: new Map([['npm-shrinkwrap.json', shrinkwrap]]),
  });
  const { result } = await inspectPullRequest({ ...options, ...mocks });
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].name, 'express-rate-limit');
});

test('a push/retarget during registry lookup cannot publish a successful stale audit', async () => {
  for (const latePull of [
    { head: { sha: '3'.repeat(40) } },
    { base: { ref: 'main', sha: '3'.repeat(40), repo: { full_name: repository } } },
  ])
    await assert.rejects(inspectPullRequest({ ...options, ...fixture({ latePull }) }), /changed/);
  const mocks = fixture();
  const { result } = await inspectPullRequest({ ...options, ...mocks });
  assert.equal(result.blocked.length, 2);
  assert.equal(mocks.requests.filter((path) => path.endsWith('/pulls/2492')).length, 2);
});

test('registry failures and absent timestamps fail closed; names fetch only once', async () => {
  const packages = [
    { name: 'example', version: '1.0.0' },
    { name: 'example', version: '1.0.1' },
  ];
  let calls = 0;
  await publicationTimes(packages, async () => {
    calls++;
    return { ok: true, json: async () => ({ time: {} }) };
  });
  assert.equal(calls, 1);
  await assert.rejects(publicationTimes(packages, async () => ({ ok: false, status: 503 })));
  await assert.rejects(publicationTimes(packages, async () => ({ ok: true, json: async () => ({}) })));
  const mocks = fixture();
  await assert.rejects(
    inspectPullRequest({
      ...options,
      ...mocks,
      registryFetch: async () => ({ ok: true, json: async () => ({ time: {} }) }),
    })
  );
});

test('comment pagination reads later pages, never a truncated first page', async () => {
  const pages = [
    Array.from({ length: 100 }, (_, index) => ({ filename: `file-${index}.txt` })),
    [{ filename: 'pnpm-lock.yaml' }],
  ];
  const values = await paginate(
    async (path) => pages[Number(new URL(`https://api.github.com/${path}`).searchParams.get('page')) - 1],
    'files'
  );
  assert.equal(values.length, 101);
  await assert.rejects(paginate(async () => Array(100).fill({}), 'files'));
});

test('a full bypass report larger than the summary bound fails rather than silently truncate', async () => {
  const versions = Array.from({ length: 5000 }, (_, index) => `1.0.0-preview.${'x'.repeat(100)}.${index}`);
  const mocks = fixture({ contents: pnpm(versions.map((version) => `@temporalio/worker@${version}`)) });
  const times = Object.fromEntries(versions.map((version) => [version, '2026-10-06T02:04:46.635Z']));
  await assert.rejects(
    inspectPullRequest({
      ...options,
      ...mocks,
      workspaceText: "minimumReleaseAge: 20160\nminimumReleaseAgeExclude: ['@temporalio/*']\n",
      registryFetch: async () => ({ ok: true, json: async () => ({ time: times }) }),
    }),
    /too large to display every bypass/
  );
});

test('publication revalidates the snapshot before any comment/check mutation', async () => {
  const requests = [];
  await assert.rejects(
    publishReport(
      async (path, opts) => {
        requests.push({ path, opts });
        return { head: { sha: '3'.repeat(40) }, base: { sha: baseSha, ref: 'main', repo: { full_name: repository } } };
      },
      repository,
      2492,
      10,
      'Report',
      'success',
      'https://github.com/run',
      {
        headSha,
        baseSha,
        baseRef: 'main',
        botLogin: 'cooldown-guard[bot]',
      }
    ),
    /head changed/
  );
  assert.equal(requests.length, 1);
  assert.ok(requests.every(({ opts }) => opts === undefined));
});

test('token-bearing requests stay on GitHub and report updates only the guard bot comment', async () => {
  const fetches = [];
  const github = githubClient('test-token', async (url, options) => {
    fetches.push({ url, options });
    return { ok: true, status: 200, json: async () => ({}) };
  });
  await github(`repos/${repository}/pulls/2492`);
  assert.equal(fetches[0].url.origin, 'https://api.github.com');
  assert.equal(fetches[0].options.headers.authorization, 'Bearer test-token');
  await assert.rejects(github('https://registry.npmjs.org/example'), /another origin/);
  assert.equal(fetches.length, 1);
  const requests = [];
  const publisher = async (path, opts) => {
    requests.push({ path, opts });
    if (path.endsWith('/pulls/2492'))
      return {
        head: { sha: headSha },
        base: { ref: 'main', sha: baseSha, repo: { full_name: repository } },
      };
    return path.includes('/comments?')
      ? [
          { id: 1, user: { login: 'someone' }, body: '<!-- dependency-cooldown-report -->' },
          { id: 2, user: { login: 'cooldown-guard[bot]' }, body: '<!-- dependency-cooldown-report --> old' },
          { id: 3, user: { login: 'github-actions[bot]' }, body: '<!-- dependency-cooldown-report --> spoofed' },
        ]
      : {};
  };
  await publishReport(publisher, repository, 2492, 10, 'New report', 'failure', 'https://github.com/run', {
    headSha,
    baseSha,
    baseRef: 'main',
    botLogin: 'cooldown-guard[bot]',
  });
  assert.ok(requests.some(({ path }) => path.endsWith('/issues/comments/2')));
  assert.ok(!requests.some(({ path }) => path.endsWith('/issues/comments/1')));
  assert.ok(!requests.some(({ path }) => path.endsWith('/issues/comments/3')));
  assert.equal(requests.at(-1).opts.body.conclusion, 'failure');
});

test('the current repository lockfiles and policy are parseable', () => {
  for (const path of ['pnpm-lock.yaml', 'packages/docs/pnpm-lock.yaml']) {
    const packages = parseLockfile(path, readFileSync(path, 'utf8'));
    assert.ok(packages.length > 0);
  }
  const policy = parsePolicy(
    readFileSync('pnpm-workspace.yaml', 'utf8'),
    readFileSync('.github/dependency-cooldown-exceptions.json', 'utf8')
  );
  assert.equal(policy.minimumReleaseAge, 20160);
});
