// Modified from: https://github.com/vercel/next.js/blob/2425f4703c4c6164cecfdb6aa8f80046213f0cc6/packages/create-next-app/helpers/examples.ts
import { Stream } from 'node:stream';
import { promisify } from 'node:util';
import { rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
// eslint-disable-next-line import/no-named-as-default
import got from 'got';
import chalk from 'chalk';
import { getErrorCode } from './get-error-code.js';
import { headers } from './headers.js';

const pipeline = promisify(Stream.pipeline);

export type RepoInfo = {
  username: string;
  name: string;
  branch: string;
  filePath: string;
};

export async function isUrlOk(url: string): Promise<boolean> {
  let res;
  try {
    res = await got.head(url, { headers });
  } catch (_e) {
    return false;
  }
  return res.statusCode === 200;
}

// https://stackoverflow.com/a/3561711/627729
function escapeRegex(s: string) {
  // eslint-disable-next-line no-useless-escape
  return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

export async function getRepoInfo(url: URL, samplePath?: string): Promise<RepoInfo> {
  const [, username, name, t, _branch, ...file] = url.pathname.split('/');
  const filePath = samplePath ? samplePath.replace(/^\//, '') : file.join('/');

  // Support repos whose entire purpose is to be a Temporal sample, e.g.
  // https://github.com/:username/:my-cool-temporal-sample-repo
  if (t === undefined) {
    const repo = `https://api.github.com/repos/${username}/${name}`;
    let infoResponse;

    try {
      // https://github.com/sindresorhus/got/blob/main/documentation/3-streams.md#response-1
      infoResponse = await got(repo, { headers });
    } catch (_error) {
      throw new Error(`Unable to fetch ${repo}`);
    }

    if (infoResponse.statusCode !== 200) {
      throw new Error(`Unable to fetch ${repo} — Code ${infoResponse.statusCode}: ${infoResponse.statusMessage}`);
    }

    const info = JSON.parse(infoResponse.body);
    return { username, name, branch: info['default_branch'], filePath };
  }

  // If samplePath is available, the branch name takes the entire path
  const branch = samplePath
    ? `${_branch}/${file.join('/')}`.replace(new RegExp(`/${escapeRegex(filePath)}|/$`), '')
    : _branch;

  if (username && name && branch && t === 'tree') {
    return { username, name, branch, filePath };
  } else {
    throw new Error(`Unable to parse URL: ${url} and sample path: ${samplePath}`);
  }
}

export async function checkForPackageJson({ username, name, branch, filePath }: RepoInfo): Promise<void> {
  const contentsUrl = `https://api.github.com/repos/${username}/${name}/contents`;
  const packagePath = `${filePath ? `/${filePath}` : ''}/package.json`;

  const fullUrl = contentsUrl + packagePath + `?ref=${branch}`;

  try {
    const response = await got.head(fullUrl, { headers });
    if (response.statusCode !== 200) {
      throw response;
    }
  } catch (e) {
    console.error(e);
    throw new Error(
      `Could not locate a package.json at ${chalk.red(
        `"${fullUrl}"`
      )}.\nPlease check that the repository is a Temporal TypeScript SDK template and try again.`
    );
  }
}

export function hasSample(name: string): Promise<boolean> {
  return isUrlOk(
    `https://api.github.com/repos/temporalio/samples-typescript/contents/${encodeURIComponent(name)}/package.json`
  );
}

export async function downloadAndExtractRepo(
  root: string,
  { username, name, branch, filePath }: RepoInfo
): Promise<void> {
  const archiveUrl = `https://codeload.github.com/${username}/${name}/tar.gz/${branch}`;
  const archivePath = `${name}-${branch}${filePath ? `/${filePath}` : ''}`;

  await pipeline(
    got.stream(archiveUrl, { headers }),
    tar.extract({ cwd: root, strip: filePath ? filePath.split('/').length + 1 : 1 }, [archivePath])
  );

  const files = await readdir(root);
  const pipelineFailed = files.length === 0;
  if (pipelineFailed) {
    console.error(
      'We were unable to download and extract the provided project.\n',
      `Archive URL: ${archiveUrl}\n`,
      `Archive path: ${archivePath}\n`,
      `Sometimes this is due to the repo name changing. If that's the case, try using the new repo URL.`
    );
    process.exit(1);
  }
}

export async function downloadAndExtractSample(root: string, name: string): Promise<void> {
  if (name === '__internal-testing-retry') {
    throw new Error('This is an internal sample for testing the CLI.');
  }

  await pipeline(
    got.stream('https://codeload.github.com/temporalio/samples-typescript/tar.gz/main', { headers }),
    tar.extract({ cwd: root, strip: 2 }, [`samples-typescript-main/${name}`])
  );

  try {
    await rm(path.join(root, `.npmrc`));
  } catch (e) {
    if (getErrorCode(e) !== 'ENOENT') {
      throw e;
    }
  }
}
