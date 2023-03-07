import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import dedent from 'dedent';
import test from 'ava';
import { replaceSdkVersion } from './install.js';
import { makeDir } from './make-dir.js';

test('replaceSdkVersion according to configured level', async (t) => {
  console.log('debug windows');
  // console.log('import.meta.url', import.meta.url);
  // console.log('URL', new URL('../../test', import.meta.url));
  const tempDir = path.join(os.tmpdir(), randomUUID());
  console.log('tempDir:', tempDir);
  await makeDir(tempDir);

  // const { pathname: tempDir } = new URL('../../test', import.meta.url);
  const packageJson = path.join(tempDir, 'package.json');
  console.log('packageJson', packageJson);
  await writeFile(
    packageJson,
    dedent`
  {
    "name": "test-create-project",
    "version": "0.1.0",
    "private": true,
    "dependencies": {
      "@temporalio/activity": "^1.0.0",
      "@temporalio/client": "^1.0.0",
      "@temporalio/worker": "^1.0.0",
      "@temporalio/workflow": "^1.0.0",
      "nanoid": "3.x"
    }
  }
  `
  );

  await replaceSdkVersion({ root: tempDir, sdkVersion: 'foo' });
  const replaced = JSON.parse(await readFile(packageJson, 'utf8'));
  t.is(replaced.dependencies['@temporalio/activity'], 'foo');
  t.is(replaced.dependencies['@temporalio/client'], 'foo');
  t.is(replaced.dependencies.nanoid, '3.x');

  await rm(tempDir, { recursive: true });
});
