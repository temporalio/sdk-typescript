import test from 'ava';
import { fetchSamples } from './fetch-samples.js';

test('only lists top-level sample directories with a package.json', async (t) => {
  const samples = await fetchSamples(async (url) => ({
    body: JSON.stringify(
      new URL(url).pathname.endsWith('/contents/')
        ? [
            { name: 'hello-world', type: 'dir' },
            { name: 'message-passing', type: 'dir' },
          ]
        : {
            truncated: false,
            tree: [
              { path: '.github/package.json', type: 'blob' },
              { path: 'hello-world/package.json', type: 'blob' },
              { path: 'message-passing/execute-update/package.json', type: 'blob' },
              { path: 'package.json', type: 'blob' },
              { path: 'test/package.json', type: 'blob' },
            ],
          }
    ),
  }));

  t.deepEqual(samples, ['hello-world']);
});
