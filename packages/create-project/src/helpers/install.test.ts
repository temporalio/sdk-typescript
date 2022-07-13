import test from 'ava';
import { replaceTemporalVersion } from './install.js';
import { URL } from 'url';
import { readFile, copyFile, rm } from 'fs/promises';
import path from 'path';

test('replaceTemporalVersion according to configured level', async (t) => {
  console.log('debug windows');
  console.log('import.meta.url', import.meta.url);
  console.log('URL', new URL('../../test', import.meta.url));
  const { pathname: testDir } = new URL('../../test', import.meta.url);
  const packageJson = path.join(testDir, 'package.json');
  console.log('packageJson', packageJson);
  const packageJsonBackup = path.join(testDir, 'package.json.bak');
  await copyFile(packageJson, packageJsonBackup);

  await replaceTemporalVersion({ root: testDir, temporalVersion: 'foo' });
  const replaced = JSON.parse(await readFile(packageJson, 'utf8'));
  t.is(replaced.dependencies['@temporalio/activity'], 'foo');
  t.is(replaced.dependencies['@temporalio/client'], 'foo');
  t.is(replaced.dependencies.nanoid, '3.x');

  // cleanup
  await copyFile(packageJsonBackup, packageJson);
  await rm(packageJsonBackup);
});
