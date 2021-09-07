// Modified from: https://github.com/vercel/next.js/blob/2425f4703c4c6164cecfdb6aa8f80046213f0cc6/packages/create-next-app/helpers/examples.ts
import chalk from 'chalk';
import got from 'got';
import tar from 'tar';
import { Stream } from 'stream';
import { promisify } from 'util';

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
    res = await got.head(url);
  } catch (e) {
    return false;
  }
  return res.statusCode === 200;
}

// https://stackoverflow.com/a/3561711/627729
function escapeRegex(s: string) {
  return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

export async function getRepoInfo(url: URL, examplePath?: string): Promise<RepoInfo> {
  const [, username, name, t, _branch, ...file] = url.pathname.split('/');
  const filePath = examplePath ? examplePath.replace(/^\//, '') : file.join('/');

  // Support repos whose entire purpose is to be a Temporal example, e.g.
  // https://github.com/:username/:my-cool-temporal-example-repo
  if (t === undefined) {
    const repo = `https://api.github.com/repos/${username}/${name}`;
    let infoResponse;

    try {
      // https://github.com/sindresorhus/got/blob/main/documentation/3-streams.md#response-1
      infoResponse = await got(repo);
    } catch (error) {
      throw new Error(`Unable to fetch ${repo}`);
    }

    if (infoResponse.statusCode !== 200) {
      throw new Error(`Unable to fetch ${repo} — Code ${infoResponse.statusCode}: ${infoResponse.statusMessage}`);
    }

    const info = JSON.parse(infoResponse.body);
    return { username, name, branch: info['default_branch'], filePath };
  }

  // If examplePath is available, the branch name takes the entire path
  const branch = examplePath
    ? `${_branch}/${file.join('/')}`.replace(new RegExp(`/${escapeRegex(filePath)}|/$`), '')
    : _branch;

  if (username && name && branch && t === 'tree') {
    return { username, name, branch, filePath };
  } else {
    throw new Error(`Unable to parse URL: ${url} and example path: ${examplePath}`);
  }
}

export async function checkForPackageJson({ username, name, branch, filePath }: RepoInfo): Promise<void> {
  const contentsUrl = `https://api.github.com/repos/${username}/${name}/contents`;
  const packagePath = `${filePath ? `/${filePath}` : ''}/package.json`;

  const fullUrl = contentsUrl + packagePath + `?ref=${branch}`;

  if (!(await isUrlOk(fullUrl))) {
    throw new Error(
      `Could not locate a package.json at ${chalk.red(
        `"${fullUrl}"`
      )}.\nPlease check that the repository is a Temporal node-sdk template and try again.`
    );
  }
}

export function hasExample(name: string): Promise<boolean> {
  return isUrlOk(
    `https://api.github.com/repos/temporalio/samples-node/contents/${encodeURIComponent(name)}/package.json`
  );
}

export function downloadAndExtractRepo(root: string, { username, name, branch, filePath }: RepoInfo): Promise<void> {
  return pipeline(
    got.stream(`https://codeload.github.com/${username}/${name}/tar.gz/${branch}`),
    tar.extract({ cwd: root, strip: filePath ? filePath.split('/').length + 1 : 1 }, [
      `${name}-${branch}${filePath ? `/${filePath}` : ''}`,
    ])
  );
}

export function downloadAndExtractExample(root: string, name: string): Promise<void> {
  if (name === '__internal-testing-retry') {
    throw new Error('This is an internal example for testing the CLI.');
  }

  return pipeline(
    got.stream('https://codeload.github.com/temporalio/samples-node/tar.gz/main'),
    tar.extract({ cwd: root, strip: 2 }, [`samples-node-main/${name}`])
  );
}
