import { parseDocument, visit } from 'yaml';
import semver from 'semver';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message) => {
  throw new Error(message);
};
// Older registry packages such as JSONStream legitimately contain uppercase letters.
const namePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
function validName(name) {
  return typeof name === 'string' && name.length <= 214 && namePattern.test(name);
}
function pair(name, version) {
  if (!validName(name) || typeof version !== 'string' || semver.valid(version) !== version) {
    fail(`Invalid registry package/version: ${name}@${version}`);
  }
  return { name, version };
}
const key = ({ name, version }) => `${name}@${version}`;
function unique(packages) {
  const values = new Map(
    packages.map(({ name, version }) => {
      const value = pair(name, version);
      return [key(value), value];
    })
  );
  return [...values.values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
function yaml(text) {
  const doc = parseDocument(text, { uniqueKeys: true, schema: 'core' });
  if (doc.errors.length) fail(`Invalid YAML: ${doc.errors[0].message}`);
  visit(doc, {
    Alias() {
      fail('YAML aliases are not permitted');
    },
    Node(_key, node) {
      if (node.tag) fail('Explicit YAML tags are not permitted');
    },
  });
  const value = doc.toJS({ maxAliasCount: 0 });
  if (!object(value)) fail('Expected a YAML mapping');
  return value;
}
const local = (value) =>
  typeof value === 'string' && /^(?:link:|file:|workspace:|git(?:\+|:)|ssh:|github:|gitlab:|bitbucket:)/.test(value);

function registryTarball(source) {
  const url = new URL(source, 'https://registry.npmjs.org/');
  if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || url.hash) {
    fail('Cannot verify a noncanonical npm registry tarball');
  }
  const match = /^\/((?:@[^/]+\/)?[^/]+)\/-\/([^/]+)\.tgz$/.exec(decodeURIComponent(url.pathname));
  if (!match) fail('Unsupported npm registry tarball path');
  const name = match[1];
  const prefix = `${name.split('/').at(-1)}-`;
  if (!match[2].startsWith(prefix)) fail('Registry tarball filename disagrees with its package');
  return pair(name, match[2].slice(prefix.length));
}

function consistentTarball(value, source) {
  const actual = registryTarball(source);
  if (value.name.toLowerCase() !== actual.name.toLowerCase() || value.version !== actual.version) {
    fail(`Registry tarball disagrees with declared identity: ${key(value)}`);
  }
  return value;
}

function consistentMetadata(value, entry) {
  if (
    (entry.version !== undefined && entry.version !== value.version) ||
    (entry.name !== undefined &&
      (typeof entry.name !== 'string' || entry.name.toLowerCase() !== value.name.toLowerCase()))
  ) {
    fail(`Package metadata disagrees with declared identity: ${key(value)}`);
  }
  return value;
}

/** Read registry identities, not importer aliases or peer-context snapshots. */
export function parseLockfile(path, text) {
  const packages = [];
  if (/(?:^|\/)pnpm-lock\.yaml$/i.test(path)) {
    const lock = yaml(text);
    if (!['9.0', 9].includes(lock.lockfileVersion)) fail('Expected pnpm lockfileVersion 9');
    if (lock.snapshots !== undefined) {
      if (!object(lock.snapshots)) fail('Invalid pnpm snapshots mapping');
      for (const snapshot of Object.values(lock.snapshots)) {
        if (!object(snapshot) || ['resolution', 'name', 'version', 'id'].some((field) => field in snapshot)) {
          fail('pnpm snapshots must not override package identity or resolution');
        }
      }
    }
    if (lock.packages === undefined) {
      if (!object(lock.importers)) fail('Missing pnpm packages/importers mappings');
      for (const importer of Object.values(lock.importers)) {
        if (!object(importer)) fail('Invalid pnpm importer');
        for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
          if (importer[section] === undefined) continue;
          if (!object(importer[section])) fail('Invalid pnpm importer dependencies');
          for (const entry of Object.values(importer[section])) {
            if (!object(entry) || !local(entry.version)) fail('Registry importer without a packages mapping');
          }
        }
      }
      return [];
    }
    if (!object(lock.packages)) fail('Expected a pnpm packages mapping');
    for (const [identity, entry] of Object.entries(lock.packages)) {
      if (!object(entry)) fail(`Invalid pnpm package entry: ${identity}`);
      if (entry.resolution !== undefined && !object(entry.resolution)) fail('Invalid pnpm resolution');
      const tarball = entry.resolution?.tarball;
      // Inspect the effective source before excluding a claimed file/git identity.
      // PNPM can fetch an npm tarball even when its package key claims to be git.
      const registrySource = typeof tarball === 'string' && !local(tarball);
      if (registrySource && entry.resolution.type) fail('Conflicting HTTP tarball and non-registry resolution');
      const directUrl = /^https?:/i.test(identity);
      const sourceDelimiter = identity.search(
        /@(?:https?:|link:|file:|workspace:|git(?:\+|:)|ssh:|github:|gitlab:|bitbucket:)/i
      );
      const split = sourceDelimiter === -1 ? identity.lastIndexOf('@') : sourceDelimiter;
      const name = identity.slice(0, split);
      const version = identity.slice(split + 1);
      const claimedLocal = local(identity) || local(version);
      if (!registrySource && claimedLocal) {
        if (!entry.resolution?.type && !local(tarball)) {
          fail('Claimed local/git identity lacks an actual non-registry resolution');
        }
        continue;
      }
      const value = claimedLocal
        ? registryTarball(tarball)
        : directUrl
          ? registryTarball(identity)
          : /^https?:/i.test(version)
            ? registryTarball(version)
            : pair(name, version);
      if (!registrySource && entry.resolution?.type) fail('Non-registry resolution behind a registry identity');
      packages.push(consistentMetadata(tarball === undefined ? value : consistentTarball(value, tarball), entry));
    }
  } else if (/(?:^|\/)(?:package-lock|npm-shrinkwrap)\.json$/i.test(path)) {
    const lock = JSON.parse(text);
    if (!object(lock) || ![2, 3].includes(lock.lockfileVersion) || !object(lock.packages)) {
      fail('Expected npm lockfileVersion 2 or 3 with a packages mapping');
    }
    for (const [location, entry] of Object.entries(lock.packages)) {
      if (!object(entry)) fail(`Invalid npm package entry: ${location}`);
      if (location === '' || !location.includes('node_modules/')) continue;
      const registrySource = typeof entry.resolved === 'string' && /^https?:/i.test(entry.resolved);
      if (registrySource && (entry.link === true || local(entry.version))) {
        fail('Registry tarball must not be disguised as a local/link npm dependency');
      }
      if (
        entry.link === true ||
        local(entry.version) ||
        (typeof entry.resolved === 'string' && /^(?:file:|git(?:\+|:)|ssh:)/.test(entry.resolved))
      )
        continue;
      const name = entry.name ?? location.slice(location.lastIndexOf('node_modules/') + 13);
      const value = /^https?:/i.test(entry.version) ? registryTarball(entry.version) : pair(name, entry.version);
      packages.push(entry.resolved === undefined ? value : consistentTarball(value, entry.resolved));
    }
  } else {
    fail(`Unsupported lockfile: ${path}`);
  }
  return unique(packages);
}

function selector(value) {
  if (typeof value !== 'string' || value.trim() !== value || !value) fail('Invalid exclusion selector');
  const split = value.indexOf('@', value.startsWith('@') ? 1 : 0);
  const pattern = split === -1 ? value : value.slice(0, split);
  const range = split === -1 ? undefined : value.slice(split + 1);
  if (!validName(pattern.replaceAll('*', 'x')) || (range !== undefined && !semver.validRange(range))) {
    fail(`Invalid exclusion selector: ${value}`);
  }
  const regex = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`
  );
  return ({ name, version }) => regex.test(name) && (range === undefined || semver.satisfies(version, range));
}

export function parsePolicy(workspaceText, exceptionsText) {
  const workspace = yaml(workspaceText);
  const minimumReleaseAge = workspace.minimumReleaseAge;
  if (!Number.isSafeInteger(minimumReleaseAge) || minimumReleaseAge < 0) fail('Invalid minimumReleaseAge');
  const excludes = workspace.minimumReleaseAgeExclude ?? [];
  if (!Array.isArray(excludes)) fail('minimumReleaseAgeExclude must be an array');
  excludes.forEach(selector);
  const document = JSON.parse(exceptionsText);
  if (
    !object(document) ||
    Object.keys(document).some((field) => field !== 'exceptions') ||
    !Array.isArray(document.exceptions)
  )
    fail('Expected an exceptions object');
  const seen = new Set();
  const exceptions = document.exceptions.map((entry) => {
    if (
      !object(entry) ||
      Object.keys(entry).some((field) => !['package', 'version', 'reason', 'advisory'].includes(field))
    )
      fail('Invalid exception fields');
    const identity = pair(entry.package, entry.version);
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 10 || !/[\p{L}\p{N}]/u.test(entry.reason))
      fail('Exception requires a meaningful reason (at least 10 characters)');
    if (
      entry.advisory !== undefined &&
      !/^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/.test(entry.advisory)
    ) {
      fail('Invalid GHSA advisory');
    }
    if (seen.has(key(identity))) fail(`Duplicate exception: ${key(identity)}`);
    seen.add(key(identity));
    return { ...entry, reason: entry.reason.trim() };
  });
  return { minimumReleaseAge, excludes: [...excludes], exceptions };
}

export function addedPackages(basePackages, headPackages) {
  const base = new Set(unique(basePackages).map(key));
  return unique(headPackages).filter((value) => !base.has(key(value)));
}

export function evaluatePackages(packages, publicationTimes, policy, now = Date.now()) {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) fail('Invalid current time');
  // Revalidate even if a caller constructs policy without parsePolicy.
  const validated = parsePolicy(
    JSON.stringify({ minimumReleaseAge: policy.minimumReleaseAge, minimumReleaseAgeExclude: policy.excludes }),
    JSON.stringify({ exceptions: policy.exceptions })
  );
  const selectors = validated.excludes.map(selector);
  const result = { checked: 0, mature: [], allowed: [], blocked: [] };
  for (const value of unique(packages)) {
    const timestamp = publicationTimes.get(value.name)?.[value.version];
    if (
      typeof timestamp !== 'string' ||
      !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
        timestamp
      )
    ) {
      fail(`Missing or invalid publication time for ${key(value)}`);
    }
    const published = Date.parse(timestamp);
    const calendarDate = timestamp.slice(0, 10);
    const calendarTime = Date.parse(`${calendarDate}T00:00:00Z`);
    if (!Number.isFinite(calendarTime) || new Date(calendarTime).toISOString().slice(0, 10) !== calendarDate) {
      fail(`Invalid publication calendar date for ${key(value)}`);
    }
    if (!Number.isFinite(published) || published > now) fail(`Invalid or future publication time for ${key(value)}`);
    const record = {
      ...value,
      publishedAt: new Date(published).toISOString(),
      ageMinutes: (now - published) / 60000,
      minimumReleaseAge: validated.minimumReleaseAge,
    };
    result.checked++;
    if (record.ageMinutes >= validated.minimumReleaseAge) {
      result.mature.push(record);
      continue;
    }
    const exception = validated.exceptions.find(
      (entry) => entry.package === value.name && entry.version === value.version
    );
    const exclusion = selectors.findIndex((matches) => matches(value));
    if (exception) {
      result.allowed.push({
        ...record,
        kind: 'approved-exception',
        reason: exception.reason,
        ...(exception.advisory ? { advisory: exception.advisory } : {}),
      });
    } else if (exclusion !== -1) {
      result.allowed.push({
        ...record,
        kind: 'configured-exclusion',
        reason: `Trusted minimumReleaseAgeExclude: ${validated.excludes[exclusion]}`,
      });
    } else result.blocked.push(record);
  }
  return result;
}

function markdown(value) {
  return String(value)
    .replace(/[<>&]/g, ' ')
    .replace(/[\r\n\u0000-\u001f\u007f]/g, ' ')
    .replace(/([\\`*_{}\[\]()|~])/g, '\\$1');
}
export function formatReport(result) {
  const lines = [
    result.allowed.length ? '# Dependency cooldown — BYPASSES ACTIVE' : '# Dependency cooldown',
    '',
    'Existing package/version pairs in base lockfiles are grandfathered and are not rechecked. New pairs are deduplicated across paths. Security PRs do not grant a bypass.',
    '',
    `Checked: ${result.checked}; mature: ${result.mature.length}; allowed immature: ${result.allowed.length}; blocked: ${result.blocked.length}.`,
    '',
    '| Package | Version | Published (UTC) | Age (minutes) | Earliest normal eligibility (UTC) | Outcome | Justification / advisory |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const record of [...result.allowed, ...result.blocked].sort((a, b) => key(a).localeCompare(key(b)))) {
    const eligible = new Date(Date.parse(record.publishedAt) + record.minimumReleaseAge * 60000).toISOString();
    lines.push(
      `| ${[
        record.name,
        record.version,
        record.publishedAt,
        record.ageMinutes.toFixed(2),
        eligible,
        record.kind ? `Allowed (${record.kind})` : 'BLOCKED',
        record.kind
          ? `${record.reason}${record.advisory ? `; ${record.advisory}` : ''}`
          : 'Minimum release age not met',
      ]
        .map(markdown)
        .join(' | ')} |`
    );
  }
  return lines.join('\n');
}
