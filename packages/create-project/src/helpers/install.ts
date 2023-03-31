// Modified from: https://github.com/vercel/next.js/blob/2425f4703c4c6164cecfdb6aa8f80046213f0cc6/packages/create-next-app/helpers/install.ts
import { readFile, writeFile } from 'node:fs/promises';

import { spawn } from './subprocess.js';
import { isUrlOk } from './samples.js';
import { getErrorCode } from './get-error-code.js';
import { glob } from 'glob';

interface InstallArgs {
  root: string;

  /**
   * Indicate whether to install packages using Yarn.
   */
  useYarn?: boolean;
  sdkVersion?: string;
}

/**
 * Spawn a package manager installation with either Yarn or NPM.
 *
 * @returns A Promise that resolves once the installation is finished.
 */
export function install({ root, useYarn }: InstallArgs): Promise<void> {
  const npm = /^win/.test(process.platform) ? 'npm.cmd' : 'npm';
  const command: string = useYarn ? 'yarn' : npm;

  return spawn(command, ['install'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ADBLOCK: '1', DISABLE_OPENCOLLECTIVE: '1' },
  });
}

export async function updateNodeVersion({ root }: InstallArgs): Promise<void> {
  const currentNodeVersion = +process.versions.node.split('.')[0];
  const versionAlreadyInPackageJson = 16;
  const minimumValidVersion = 14;

  if (currentNodeVersion >= minimumValidVersion && currentNodeVersion !== versionAlreadyInPackageJson) {
    const packageName = `@tsconfig/node${currentNodeVersion}`;
    const fileNames = await glob([`${root}/**/package.json`, `${root}/**/tsconfig.json`]);

    const packageExists = await isUrlOk(`https://registry.npmjs.org/${packageName}`);
    if (packageExists) {
      for (const fileName of fileNames) {
        const fileString = (await readFile(fileName)).toString();
        await writeFile(fileName, fileString.replace(`@tsconfig/node${versionAlreadyInPackageJson}`, packageName));
      }
    }

    await writeFile(`${root}/.nvmrc`, currentNodeVersion.toString());
  }
}

export async function replaceSdkVersion({ root, sdkVersion }: InstallArgs): Promise<void> {
  const fileName = `${root}/package.json`;

  const packageJson = JSON.parse(await readFile(fileName, 'utf8'));
  for (const packageName in packageJson.dependencies) {
    if (packageName.startsWith('@temporalio/')) {
      packageJson.dependencies[packageName] = sdkVersion;
    }
  }
  await writeFile(fileName, JSON.stringify(packageJson));
}
