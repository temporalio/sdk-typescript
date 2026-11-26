// oxlint-disable-next-line import/no-named-as-default
import got from 'got';
import { headers } from './headers.js';

const SAMPLE_REPO_TREE = 'https://api.github.com/repos/temporalio/samples-typescript/git/trees/main?recursive=1';

interface SampleRepoTree {
  tree: { path: string; type: string }[];
  truncated: boolean;
}

export async function fetchSamples(
  get: (url: string, options: { headers: typeof headers }) => Promise<{ body: string }> = got
): Promise<string[]> {
  let response;

  try {
    // https://github.com/sindresorhus/got/blob/main/documentation/3-streams.md#response-1
    response = await get(SAMPLE_REPO_TREE, { headers });
  } catch (_error) {
    throw new Error(`Unable to reach github.com`);
  }

  const { tree, truncated } = JSON.parse(response.body) as SampleRepoTree;
  if (truncated) {
    throw new Error('Unable to list samples: GitHub returned an incomplete repository tree');
  }

  return tree
    .filter(({ path, type }) => type === 'blob' && /^[^./][^/]*\/package\.json$/.test(path))
    .map(({ path }) => path.slice(0, path.indexOf('/')))
    .filter((name) => name !== 'test');
}
