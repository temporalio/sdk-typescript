import test from 'ava';
import { replaceTemporalVersion } from './install.js';
import { URL } from 'url';
import { readFile, copyFile, rm } from 'fs/promises';
import path from 'path';

test('replaceTemporalVersion according to configured level', async (t) => {
  const { pathname: testDir } = new URL('../../test', import.meta.url);
  const packageJson = path.join(testDir, 'package.json');
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
