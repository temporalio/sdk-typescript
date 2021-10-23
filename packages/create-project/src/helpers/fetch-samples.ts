import got from 'got';

const SAMPLE_REPO_CONTENTS = 'https://api.github.com/repos/temporalio/samples-typescript/contents/';

interface File {
  name: string;
  type: string;
}

export async function fetchSamples(): Promise<string[]> {
  let response;

  try {
    // https://github.com/sindresorhus/got/blob/main/documentation/3-streams.md#response-1
    response = await got(SAMPLE_REPO_CONTENTS);
  } catch (error) {
    throw new Error(`Unable to reach github.com`);
  }

  const files = JSON.parse(response.body) as File[];

  return files.filter((file) => file.type === 'dir' && file.name !== 'test' && !file.name.startsWith('.')).map(({ name }) => name);
}
