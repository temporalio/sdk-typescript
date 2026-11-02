import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import dedent from 'dedent';
import test from 'ava';
import { replaceSdkVersion, updateNodeVersion, updateTsconfigNodeVersion } from './install.js';
import { makeDir } from './make-dir.js';

test('updateTsconfigNodeVersion supports comments and trailing commas', (t) => {
  const updated = updateTsconfigNodeVersion(
    dedent`
      {
        // TypeScript configuration files support JSONC.
        "extends": "@tsconfig/node20/tsconfig.json",
        "compilerOptions": {
          "strict": true,
        },
      }
    `,
    '@tsconfig/node24'
  );

  t.is(
    updated,
    dedent`
      {
        // TypeScript configuration files support JSONC.
        "extends": "@tsconfig/node24/tsconfig.json",
        "compilerOptions": {
          "strict": true,
        },
      }
    `
  );
});

for (const nodeVersion of [26, 28]) {
  test(`updateNodeVersion preserves the sample's TypeScript configuration on Node ${nodeVersion}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'temporal-create-'));
    t.teardown(() => rm(root, { recursive: true, force: true }));

    const packageJson = JSON.stringify({
      devDependencies: { '@tsconfig/node22': '^22.0.0', typescript: '^5.6.3' },
    });
    const tsconfig = dedent`
      {
        // Keep the configuration compatible with the sample's TypeScript version.
        "extends": "@tsconfig/node22/tsconfig.json",
        "compilerOptions": { "strict": true, },
      }
    `;
    const nestedRoot = path.join(root, 'worker');
    await makeDir(nestedRoot);
    for (const directory of [root, nestedRoot]) {
      await writeFile(path.join(directory, 'package.json'), packageJson);
      await writeFile(path.join(directory, 'tsconfig.json'), tsconfig);
    }
    await writeFile(path.join(root, '.nvmrc'), '22');

    await updateNodeVersion({ root }, nodeVersion);

    for (const directory of [root, nestedRoot]) {
      t.is(await readFile(path.join(directory, 'package.json'), 'utf8'), packageJson);
      t.is(await readFile(path.join(directory, 'tsconfig.json'), 'utf8'), tsconfig);
    }
    t.is(await readFile(path.join(root, '.nvmrc'), 'utf8'), nodeVersion.toString());
  });
}

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
