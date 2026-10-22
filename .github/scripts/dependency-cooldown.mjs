import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  addedPackages,
  evaluatePackages,
  formatReport,
  parseLockfile,
  parsePolicy,
} from './dependency-cooldown-policy.mjs';

const checkName = 'Dependency cooldown';
const commentMarker = '<!-- dependency-cooldown-report -->';
const lockfile = (path) => /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json)$/i.test(path);
const sha = (value) => /^[a-f0-9]{40}$/.test(value);
const maxLockfileBytes = 10 * 1024 * 1024;

/** The GitHub token is sent only to GitHub, never to the npm registry. */
export function githubClient(token, fetcher = fetch, apiUrl = 'https://api.github.com/') {
  const base = new URL(apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`);
  if (base.protocol !== 'https:') throw new Error('GitHub API must use HTTPS');
  return async (path, { method = 'GET', body } = {}) => {
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new Error('Refusing to send the GitHub token to another origin');
    const response = await fetcher(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  };
}

export async function paginate(github, path) {
  const results = [];
  for (let page = 1; ; page++) {
    const values = await github(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(values)) throw new Error(`Expected a paginated array: ${path}`);
    results.push(...values);
    if (values.length < 100) return results;
    if (page >= 30) throw new Error(`Too many results to audit completely: ${path}`);
  }
}

export function gitBlobSha(contents) {
  const bytes = Buffer.from(contents);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function lockTree(github, repository, revision) {
  const response = await github(`repos/${repository}/git/trees/${revision}?recursive=1`);
  if (response.truncated !== false || !Array.isArray(response.tree)) {
    throw new Error('Incomplete immutable Git tree');
  }
  const entries = new Map();
  for (const entry of response.tree) {
    if (typeof entry.path !== 'string') throw new Error('Invalid Git tree entry');
    if (!lockfile(entry.path)) continue;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || !sha(entry.sha)) {
      throw new Error(`Unsupported lockfile tree entry: ${entry.path}`);
    }
    if (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size > maxLockfileBytes)) {
      throw new Error(`Oversized lockfile tree entry: ${entry.path}`);
    }
    if (entries.has(entry.path)) throw new Error(`Duplicate Git tree entry: ${entry.path}`);
    entries.set(entry.path, entry.sha);
  }
  return entries;
}

async function headLockfile(github, repository, path, blobSha) {
  const file = await github(`repos/${repository}/git/blobs/${blobSha}`);
  if (file.encoding !== 'base64' || typeof file.content !== 'string') {
    throw new Error(`Missing lockfile contents: ${path}`);
  }
  const contents = Buffer.from(file.content, 'base64');
  if (contents.length > maxLockfileBytes || gitBlobSha(contents) !== blobSha) {
    throw new Error(`Oversized lockfile or blob identity mismatch: ${path}`);
  }
  return contents.toString('utf8');
}

async function verifySnapshot(github, repository, number, headSha, baseSha, baseRef) {
  const pull = await github(`repos/${repository}/pulls/${number}`);
  if (pull.head?.sha !== headSha) throw new Error('Pull request head changed; rerun the check');
  if (pull.base?.repo?.full_name !== repository) throw new Error('Unexpected pull request base repository');
  if (pull.base.sha !== baseSha || (baseRef !== undefined && pull.base.ref !== baseRef)) {
    throw new Error('Pull request base changed; rerun the check');
  }
}

export async function publicationTimes(packages, fetcher = fetch) {
  const names = [...new Set(packages.map(({ name }) => name))];
  const times = new Map();
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, names.length) }, async () => {
      while (index < names.length) {
        const name = names[index++];
        const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Cannot verify publication dates for ${name}: HTTP ${response.status}`);
        const metadata = await response.json();
        if (!metadata.time || typeof metadata.time !== 'object' || Array.isArray(metadata.time)) {
          throw new Error(`Missing publication dates for ${name}`);
        }
        times.set(name, metadata.time);
      }
    })
  );
  return times;
}

/** Head content is fetched as data; all executable code and policy stay on the base branch. */
export async function inspectPullRequest({
  github,
  repository,
  number,
  headSha,
  baseSha,
  baseLockfiles,
  workspaceText,
  exceptionsText,
  baseRef,
  registryFetch = fetch,
  now = Date.now(),
}) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !sha(headSha) ||
    !sha(baseSha)
  )
    throw new Error('Invalid pull request identity');
  const policy = parsePolicy(workspaceText, exceptionsText);
  await verifySnapshot(github, repository, number, headSha, baseSha, baseRef);
  const ancestry = await github(`repos/${repository}/compare/${baseSha}...${headSha}`);
  if (!['ahead', 'identical'].includes(ancestry.status)) {
    throw new Error('Pull request must include the current base branch before auditing');
  }
  const [baseTree, headTree] = await Promise.all([
    lockTree(github, repository, baseSha),
    lockTree(github, repository, headSha),
  ]);
  if (
    baseTree.size !== baseLockfiles.size ||
    [...baseTree].some(([path, blobSha]) => !baseLockfiles.has(path) || gitBlobSha(baseLockfiles.get(path)) !== blobSha)
  ) {
    throw new Error('Trusted checkout lockfiles do not match the immutable base tree');
  }
  const basePackages = [...baseLockfiles].flatMap(([path, contents]) => parseLockfile(path, contents));
  const headPackages = [];
  for (const [path, blobSha] of headTree) {
    if (baseTree.get(path) === blobSha) continue;
    headPackages.push(...parseLockfile(path, await headLockfile(github, repository, path, blobSha)));
  }
  const added = addedPackages(basePackages, headPackages);
  if (added.length > 5000) throw new Error('Too many new package versions to audit in one pull request');
  const times = await publicationTimes(added, registryFetch);
  const result = evaluatePackages(added, times, policy, now);
  const report = [
    formatReport(result),
    '',
    `Audited head: \`${headSha}\`; trusted base: \`${baseSha}\`.`,
    '',
    `Trusted minimum release age: ${policy.minimumReleaseAge} minutes.`,
    '',
    'Exceptions and settings are read only from the trusted base branch. Changes in this PR cannot authorize its own bypass.',
  ].join('\n');
  if (Buffer.byteLength(report, 'utf8') > 900 * 1024) {
    throw new Error('Audit report is too large to display every bypass; split the dependency update');
  }
  await verifySnapshot(github, repository, number, headSha, baseSha, baseRef);
  return { result, report };
}

function shortSummary(report, runUrl) {
  // GitHub check outputs and comments have a 65,535-character limit.
  return report.length < 60_000
    ? report
    : `${report.slice(0, 60_000)}\n\nReport truncated here; see the complete [workflow summary](${runUrl}).`;
}

export async function publishReport(github, repository, number, checkId, report, conclusion, runUrl, snapshot) {
  await verifySnapshot(github, repository, number, snapshot.headSha, snapshot.baseSha, snapshot.baseRef);
  const summary = shortSummary(report, runUrl);
  const comments = await paginate(github, `repos/${repository}/issues/${number}/comments`);
  const existing = comments.find(
    (comment) => comment.user?.login === snapshot.botLogin && comment.body?.startsWith(commentMarker)
  );
  const body = `${commentMarker}\n${summary}`;
  if (existing) {
    await github(`repos/${repository}/issues/comments/${existing.id}`, { method: 'PATCH', body: { body } });
  } else {
    await github(`repos/${repository}/issues/${number}/comments`, { method: 'POST', body: { body } });
  }
  await github(`repos/${repository}/check-runs/${checkId}`, {
    method: 'PATCH',
    body: {
      status: 'completed',
      conclusion,
      output: {
        title:
          conclusion !== 'success'
            ? 'Dependency cooldown blocked'
            : snapshot.allowedCount
              ? `Dependency cooldown: ${snapshot.allowedCount} approved bypasses`
              : 'Dependency cooldown satisfied',
        summary,
      },
    },
  });
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const number = Number(process.env.PR_NUMBER);
  const token = process.env.COOLDOWN_APP_TOKEN;
  const botLogin = process.env.COOLDOWN_APP_BOT_LOGIN;
  const appId = Number(process.env.COOLDOWN_APP_ID);
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !Number.isSafeInteger(number) || number < 1) {
    throw new Error('COOLDOWN_APP_TOKEN, GITHUB_REPOSITORY and a valid PR_NUMBER are required');
  }
  if (!Number.isSafeInteger(appId) || appId < 1 || !/^[a-z0-9-]+\[bot\]$/i.test(botLogin ?? '')) {
    throw new Error('A dedicated COOLDOWN_APP_ID and COOLDOWN_APP_BOT_LOGIN are required');
  }
  const github = githubClient(token, fetch, process.env.GITHUB_API_URL);
  const pull = await github(`repos/${repository}/pulls/${number}`);
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const headSha = event.pull_request?.head?.sha ?? pull.head.sha;
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const check = await github(`repos/${repository}/check-runs`, {
    method: 'POST',
    body: { name: checkName, head_sha: headSha, status: 'in_progress', details_url: runUrl },
  });
  if (check.app?.id !== appId) throw new Error('Check was not created by the configured cooldown App');
  let report;
  let conclusion = 'failure';
  let allowedCount = 0;
  try {
    const tracked = execFileSync('git', ['ls-files', '-z'], {
      encoding: 'utf8',
    })
      .split('\0')
      .filter(lockfile);
    const baseLockfiles = new Map(tracked.map((path) => [path, readFileSync(path, 'utf8')]));
    const inspected = await inspectPullRequest({
      github,
      repository,
      number,
      headSha,
      baseSha,
      baseLockfiles,
      baseRef: process.env.BASE_REF,
      workspaceText: readFileSync('pnpm-workspace.yaml', 'utf8'),
      exceptionsText: readFileSync('.github/dependency-cooldown-exceptions.json', 'utf8'),
    });
    report = inspected.report;
    conclusion = inspected.result.blocked.length ? 'failure' : 'success';
    allowedCount = inspected.result.allowed.length;
    for (const allowed of inspected.result.allowed) {
      console.log(
        `::warning title=Dependency cooldown bypass::${allowed.name}@${allowed.version} is ${allowed.ageMinutes.toFixed(
          0
        )} minutes old (${allowed.kind}). See the audit report.`
      );
    }
  } catch (error) {
    const diagnostic = String(error.message)
      .replace(/`/g, "'")
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .slice(0, 2000);
    report = `# Dependency cooldown — VERIFICATION FAILED\n\n\`\`\`text\n${diagnostic}\n\`\`\`\n\nNo bypass was granted. Resolve this error and rerun the check.`;
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  try {
    await publishReport(github, repository, number, check.id, report, conclusion, runUrl, {
      headSha,
      baseSha,
      baseRef: process.env.BASE_REF,
      botLogin,
      allowedCount,
    });
  } catch (error) {
    // A reporting failure must not leave an apparently successful check.
    await github(`repos/${repository}/check-runs/${check.id}`, {
      method: 'PATCH',
      body: {
        status: 'completed',
        conclusion: 'failure',
        output: {
          title: 'Cooldown reporting failed',
          summary: 'Could not publish the audit report. Rerun this workflow.',
        },
      },
    });
    throw error;
  }
  if (conclusion !== 'success') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
