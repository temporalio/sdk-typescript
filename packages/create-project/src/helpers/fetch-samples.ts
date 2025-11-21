// eslint-disable-next-line import/no-named-as-default
import got from 'got';
import { headers } from './headers.js';

const SAMPLE_REPO_CONTENTS = 'https://api.github.com/repos/temporalio/samples-typescript/contents/';

interface File {
  name: string;
  type: string;
}

export async function fetchSamples(): Promise<string[]> {
  let response;

  try {
    // https://github.com/sindresorhus/got/blob/main/documentation/3-streams.md#response-1
    response = await got(SAMPLE_REPO_CONTENTS, { headers });
  } catch (_error) {
    throw new Error(`Unable to reach github.com`);
  }

  const files = JSON.parse(response.body) as File[];

  return files
    .filter((file) => file.type === 'dir' && file.name !== 'test' && !file.name.startsWith('.'))
    .map(({ name }) => name);
}
