// Modified from: https://github.com/vercel/next.js/blob/2425f4703c4c6164cecfdb6aa8f80046213f0cc6/packages/create-next-app/helpers/install.ts
import { spawn } from './subprocess';
import { readFileSync, writeFileSync } from 'fs';

import { isUrlOk } from './samples';

interface InstallArgs {
  root: string;

  /**
   * Indicate whether to install packages using Yarn.
   */
  useYarn?: boolean;
}

/**
 * Spawn a package manager installation with either Yarn or NPM.
 *
 * @returns A Promise that resolves once the installation is finished.
 */
export function install({ root, useYarn }: InstallArgs): Promise<void> {
  return runNpmCommand(['install'], { root, useYarn });
}

export async function updateNodeVersion({ root }: InstallArgs): Promise<void> {
  const currentNodeVersion = +process.versions.node.split('.')[0];
  const versionAlreadyInPackageJson = 16;
  const minimumValidVersion = 14;

  if (currentNodeVersion >= minimumValidVersion && currentNodeVersion !== versionAlreadyInPackageJson) {
    const packageName = `@tsconfig/node${currentNodeVersion}`;
    const fileName = `${root}/package.json`;

    const packageExists = await isUrlOk(`https://registry.npmjs.org/${packageName}`);
    if (packageExists) {
      const fileString = readFileSync(fileName).toString();
      writeFileSync(fileName, fileString.replace('@tsconfig/node16', packageName));
    }

    writeFileSync(`${root}/.nvmrc`, currentNodeVersion.toString());
  }
}

export function installWithLatestTemporalVersion({ root, useYarn }: InstallArgs): Promise<void> {
  const fileName = `${root}/package.json`;

  const packageJson = readFileSync(fileName).toString();
  const lines = packageJson.split('\n');
  const lineIndex = lines.findIndex((line) => /"temporalio":/.test(line));

  // If previous line is a dependency, remove trailing comma
  lines[lineIndex - 1] = lines[lineIndex - 1].replace(',', '');

  lines.splice(lineIndex, 1);
  writeFileSync(fileName, lines.join('\n'));

  return runNpmCommand(['install', 'temporalio'], { root, useYarn });
}

function runNpmCommand(args: string[], { root, useYarn }: InstallArgs): Promise<void> {
  const npm = /^win/.test(process.platform) ? 'npm.cmd' : 'npm';
  const command: string = useYarn ? 'yarn' : npm;

  return spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ADBLOCK: '1', DISABLE_OPENCOLLECTIVE: '1' },
  });
}
