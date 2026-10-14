import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLockfile,
  parsePolicy,
  addedPackages,
  evaluatePackages,
  formatReport,
} from './dependency-cooldown-policy.mjs';

const now = Date.parse('2026-06-01T00:00:00Z');
const workspace = 'minimumReleaseAge: 20160\nminimumReleaseAgeExclude: []\n';
const policy = (exceptions = [], text = workspace) => parsePolicy(text, JSON.stringify({ exceptions }));
const pkg = (name, version) => ({ name, version });
const time = (packages, age = 60) =>
  new Map(packages.map(({ name, version }) => [name, { [version]: new Date(now - age * 60000).toISOString() }]));
const exception = {
  package: '@modelcontextprotocol/sdk',
  version: '1.31.0',
  reason: 'Approved targeted security remediation',
  advisory: 'GHSA-2345-6789-cfgh',
};

test('PR2492 exception is exact; collateral and subsequent MCP releases stay blocked', () => {
  const packages = [pkg(exception.package, '1.31.0'), pkg('express-rate-limit', '8.7.1')];
  const result = evaluatePackages(packages, time(packages), policy([exception]), now);
  assert.equal(result.checked, 2);
  assert.equal(result.allowed[0].kind, 'approved-exception');
  assert.equal(result.allowed[0].advisory, exception.advisory);
  assert.deepEqual(
    result.blocked.map(({ name }) => name),
    ['express-rate-limit']
  );
  const next = [pkg(exception.package, '1.32.1')];
  assert.equal(evaluatePackages(next, time(next), policy([exception]), now).blocked.length, 1);
});

test('stable versions mature exactly at threshold; bypass expires', () => {
  const packages = [pkg(exception.package, exception.version)];
  for (const age of [20160, 20161]) {
    const result = evaluatePackages(packages, time(packages, age), policy([exception]), now);
    assert.equal(result.mature.length, 1);
    assert.equal(result.allowed.length, 0);
  }
  assert.equal(evaluatePackages(packages, time(packages, 20159), policy(), now).blocked.length, 1);
});

test('grandfathering ignores removals, file paths, duplicates and peer contexts', () => {
  const a = parseLockfile(
    'pnpm-lock.yaml',
    `lockfileVersion: '9.0'
packages:
  foo@1.0.0: {}
snapshots:
  foo@1.0.0(bar@2.0.0): {}
`
  );
  const b = parseLockfile(
    'packages/docs/pnpm-lock.yaml',
    `lockfileVersion: '9.0'
packages:
  foo@1.0.0: {}
  bar@2.0.0: {}
snapshots:
  foo@1.0.0(bar@3.0.0): {}
`
  );
  assert.deepEqual(addedPackages([...a, pkg('removed', '1.0.0')], [...b, ...b]), [pkg('bar', '2.0.0')]);
  assert.deepEqual(addedPackages(b, a), []);
});

test('pnpm registry identities handle scoped aliases and ignore local dependencies', () => {
  assert.deepEqual(
    parseLockfile(
      'pnpm-lock.yaml',
      `lockfileVersion: 9.0
packages:
  '@scope/actual@1.2.3': {}
  plain@2.0.0: {}
  'local@file:../local': {resolution: {type: directory, directory: ../local}}
  'git+https://github.com/org/repo': {resolution: {type: git, repo: 'https://github.com/org/repo', commit: abc}}
importers:
  .:
    dependencies:
      alias:
        version: '@scope/actual@1.2.3'
`
    ),
    [pkg('@scope/actual', '1.2.3'), pkg('plain', '2.0.0')]
  );
});

test('npm v2/v3 nested, scoped and aliased identities dedupe; workspaces/file/git excluded', () => {
  for (const lockfileVersion of [2, 3]) {
    const text = JSON.stringify({
      lockfileVersion,
      packages: {
        '': { name: 'root' },
        'packages/local': { name: 'local', version: '1.0.0' },
        'node_modules/alias': { name: '@scope/actual', version: '1.2.3' },
        'node_modules/x/node_modules/@scope/actual': { version: '1.2.3' },
        'node_modules/local': { resolved: 'packages/local', link: true },
        'node_modules/file': { version: '1.0.0', resolved: 'file:../file' },
        'node_modules/git': { version: '1.0.0', resolved: 'git+https://github.com/o/r' },
      },
    });
    assert.deepEqual(parseLockfile('package-lock.json', text), [pkg('@scope/actual', '1.2.3')]);
  }
});

test('canonical registry tarballs cannot hide a newer version behind an older identity', () => {
  const source = 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz';
  const direct = parseLockfile(
    'pnpm-lock.yaml',
    `lockfileVersion: '9.0'
packages:
  'is-number@${source}': {resolution: {tarball: '${source}'}}
`
  );
  assert.deepEqual(direct, [pkg('is-number', '7.0.0')]);
  assert.throws(
    () =>
      parseLockfile(
        'pnpm-lock.yaml',
        `lockfileVersion: '9.0'
packages:
  is-number@6.0.0: {resolution: {tarball: '${source}'}}
`
      ),
    /disagrees/
  );
  assert.throws(
    () =>
      parseLockfile(
        'package-lock.json',
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            'node_modules/is-number': { name: 'other-package', version: '7.0.0', resolved: source },
          },
        })
      ),
    /disagrees/
  );
});

test('PNPM package-level version overrides and git-looking npm tarballs cannot evade the audit', () => {
  assert.throws(
    () =>
      parseLockfile(
        'pnpm-lock.yaml',
        `lockfileVersion: '9.0'
packages:
  is-number@6.0.0:
    version: 7.0.0
    resolution: {integrity: 'sha512-placeholder'}
snapshots:
  is-number@6.0.0: {}
`
      ),
    /metadata disagrees/
  );
  assert.deepEqual(
    parseLockfile(
      'pnpm-lock.yaml',
      `lockfileVersion: '9.0'
packages:
  'is-number@git+https://github.com/jonschlinkert/is-number.git#aaaaaaaa':
    version: 7.0.0
    resolution: {tarball: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz'}
`
    ),
    [pkg('is-number', '7.0.0')]
  );
  assert.deepEqual(
    parseLockfile(
      'pnpm-lock.yaml',
      `lockfileVersion: '9.0'
packages:
  'is-number@file:../claimed-local':
    version: 7.0.0
    resolution: {tarball: 'is-number/-/is-number-7.0.0.tgz'}
`
    ),
    [pkg('is-number', '7.0.0')]
  );
  assert.throws(
    () =>
      parseLockfile(
        'pnpm-lock.yaml',
        `lockfileVersion: '9.0'
packages:
  'is-number@git+https://github.com/jonschlinkert/is-number.git#aaaaaaaa':
    version: 7.0.0
    resolution: {integrity: 'sha512-placeholder'}
`
      ),
    /lacks an actual non-registry resolution/
  );
  assert.throws(
    () =>
      parseLockfile(
        'npm-shrinkwrap.json',
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            'node_modules/is-number': {
              version: 'file:../local',
              resolved: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
            },
          },
        })
      ),
    /disguised/
  );
});

test('scoped/encoded registry aliases and npm shrinkwrap use actual tarball identities', () => {
  const source = 'https://registry.npmjs.org/@scope%2Factual/-/actual-1.2.3.tgz';
  assert.deepEqual(
    parseLockfile(
      'npm-shrinkwrap.json',
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/alias': { name: '@scope/actual', version: '1.2.3', resolved: source },
          'node_modules/bundled': { version: '2.0.0', inBundle: true },
        },
      })
    ),
    [pkg('@scope/actual', '1.2.3'), pkg('bundled', '2.0.0')]
  );
  assert.throws(
    () =>
      parseLockfile(
        'pnpm-lock.yaml',
        `lockfileVersion: '9.0'
packages:
  'foo@https://mirror.example/foo-1.0.0.tgz': {}
`
      ),
    /noncanonical/
  );
});

test('valid empty/local-only pnpm locks omit packages; unresolved registry imports do not', () => {
  assert.deepEqual(
    parseLockfile(
      'pnpm-lock.yaml',
      `lockfileVersion: '9.0'
importers:
  .: {}
`
    ),
    []
  );
  assert.deepEqual(
    parseLockfile(
      'pnpm-lock.yaml',
      `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      foo: {specifier: 'link:../foo', version: 'link:../foo'}
`
    ),
    []
  );
  assert.throws(
    () =>
      parseLockfile(
        'pnpm-lock.yaml',
        `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      foo: {specifier: '^1.0.0', version: '1.0.0'}
`
      ),
    /without a packages mapping/
  );
});

test('configured scope glob, plain name, exact version and semver selectors', () => {
  const configured = policy(
    [],
    `minimumReleaseAge: 20160
minimumReleaseAgeExclude:
  - '@temporalio/*'
  - nexus-rpc
  - '@ai-sdk/provider-utils@5.0.53'
  - 'ranged@>=2.0.0 <3'
`
  );
  const packages = [
    pkg('@temporalio/worker', '1.0.0'),
    pkg('nexus-rpc', '1.0.0'),
    pkg('@ai-sdk/provider-utils', '5.0.53'),
    pkg('ranged', '2.1.0'),
    pkg('@ai-sdk/provider-utils', '5.0.54'),
    pkg('ranged', '3.0.0'),
  ];
  const times = new Map();
  for (const { name, version } of packages) {
    times.set(name, { ...times.get(name), [version]: new Date(now - 60000).toISOString() });
  }
  const result = evaluatePackages(packages, times, configured, now);
  assert.equal(result.allowed.length, 4);
  assert.equal(result.blocked.length, 2);
  assert.ok(result.allowed.every((entry) => entry.kind === 'configured-exclusion'));
});

test('metadata fails closed even for exclusions and approved exceptions', () => {
  const packages = [pkg(exception.package, exception.version)];
  for (const timestamp of [undefined, 'bad', '2026-06-02T00:00:00Z', '2026-02-30T00:00:00Z']) {
    assert.throws(() =>
      evaluatePackages(
        packages,
        new Map([[exception.package, { [exception.version]: timestamp }]]),
        policy([exception]),
        now
      )
    );
  }
});

test('malformed policy and exceptions fail closed', () => {
  for (const text of [
    '',
    'minimumReleaseAge: -1',
    'minimumReleaseAge: 1.5',
    'minimumReleaseAge: 10\nminimumReleaseAgeExclude: nope',
    'minimumReleaseAge: 10\nminimumReleaseAgeExclude: [foo@invalid]',
  ]) {
    assert.throws(() => policy([], text));
  }
  for (const entry of [
    { ...exception, version: '*' },
    { ...exception, version: '^1.31.0' },
    { ...exception, reason: '' },
    { ...exception, reason: '!!!!!!!!!!' },
    { ...exception, extra: true },
    { ...exception, advisory: 'not-an-advisory' },
    { ...exception, package: '<script>' },
  ])
    assert.throws(() => policy([entry]));
  assert.throws(() => policy([exception, exception]));
  assert.throws(() => parsePolicy(workspace, '{"exceptions":[],"unknown":true}'));
});

test('unsupported/malformed lockfiles, duplicate keys, YAML aliases and tags rejected', () => {
  for (const text of [
    'lockfileVersion: 8\npackages: {}',
    'lockfileVersion: 9',
    'lockfileVersion: 9\npackages: []',
    'lockfileVersion: 9\npackages:\n  foo@1.0.0: {}\n  foo@1.0.0: {}',
    'lockfileVersion: 9\npackages: &p {}\nsnapshots: *p',
    'lockfileVersion: 9\npackages: !!map {}',
    'lockfileVersion: 9\npackages:\n  foo@latest: {}',
    'lockfileVersion: 9\npackages:\n  bad/name@1.0.0: {}',
    'lockfileVersion: 9\npackages:\n  foo@1.0.0: {}\nsnapshots:\n  foo@1.0.0: {resolution: {tarball: "https://registry.npmjs.org/foo/-/foo-2.0.0.tgz"}}',
  ])
    assert.throws(() => parseLockfile('pnpm-lock.yaml', text));
  assert.throws(() => parseLockfile('yarn.lock', ''));
  assert.throws(() => parseLockfile('package-lock.json', '{"lockfileVersion":1,"packages":{}}'));
  assert.throws(() => parseLockfile('package-lock.json', '{"lockfileVersion":3,"packages":{"node_modules/foo":{}}}'));
});

test('report includes every immature version and neutralizes Markdown/HTML/control characters', () => {
  const packages = [pkg(exception.package, exception.version), pkg('express-rate-limit', '8.7.1')];
  const malicious = { ...exception, reason: 'Approved <script> [click](https://bad) | **bold**\n# heading' };
  const result = evaluatePackages(packages, time(packages), policy([malicious]), now);
  const report = formatReport(result);
  assert.match(report, /BYPASSES ACTIVE/);
  assert.match(report, /grandfathered/);
  assert.match(report, /2026-06-14T23:00:00\.000Z/);
  assert.match(report, /BLOCKED/);
  assert.match(report, /GHSA/);
  assert.ok(!report.includes('<script>'));
  assert.ok(!report.includes('[click]('));
  assert.ok(!report.includes('\n# heading'));
  assert.equal(report.split('\n').filter((line) => line.startsWith('| ')).length, 4);
});
