// Modified from: https://github.com/vercel/next.js/blob/2425f4703c4c6164cecfdb6aa8f80046213f0cc6/packages/create-next-app/helpers/install.ts
import { readFile, writeFile } from 'node:fs/promises';
import { glob } from 'glob';
import { spawn } from './subprocess.js';
import { isUrlOk } from './samples.js';

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
  const isWindows = process.platform === 'win32';
  const npm = isWindows ? 'npm.cmd' : 'npm';
  const command: string = useYarn ? 'yarn' : npm;

  return spawn(command, ['install'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ADBLOCK: '1', DISABLE_OPENCOLLECTIVE: '1' },
    shell: isWindows,
  });
}

export async function updateNodeVersion({ root }: InstallArgs): Promise<void> {
  const currentNodeVersion = +process.versions.node.split('.')[0];

  const packageName = `@tsconfig/node${currentNodeVersion}`;

  const packageExists = await isUrlOk(`https://registry.npmjs.org/${packageName}`);
  if (packageExists) {
    const packageFileNames = await glob('**/package.json', { cwd: root, absolute: true, root: '' });
    for (const fileName of packageFileNames) {
      const packageJson = JSON.parse((await readFile(fileName, 'utf8')).toString());

      const existingDependency = Object.keys(packageJson.devDependencies || {}).find((dep) =>
        /^@tsconfig\/node\d+$/.test(dep)
      );
      if (existingDependency) {
        delete packageJson.devDependencies[existingDependency];

        // Only add a dependency to `@tsconfig/nodeX` if there was already such a dependency; for
        // various reasons, some package.json files just don't need it. The version scheme used by
        // this project nowadays is to match the major version of the current Node.js version,
        // e.g. `@tsconfig/node22` will have version `22.x.x`.
        packageJson.devDependencies[packageName] = `^${currentNodeVersion}.0.0`;
        await writeFile(fileName, JSON.stringify(packageJson, null, 2));
      }
    }

    const tsconfigFileNames = await glob('**/tsconfig.json', { cwd: root, absolute: true, root: '' });
    for (const fileName of tsconfigFileNames) {
      const tsconfigJson = JSON.parse((await readFile(fileName, 'utf8')).toString());
      if (tsconfigJson.extends && /^@tsconfig\/node\d+\/tsconfig\.json$/.test(tsconfigJson.extends)) {
        tsconfigJson.extends = `${packageName}/tsconfig.json`;
        await writeFile(fileName, JSON.stringify(tsconfigJson, null, 2));
      }
    }

    await writeFile(`${root}/.nvmrc`, currentNodeVersion.toString());
  }
}

export async function replaceSdkVersion({ root, sdkVersion }: InstallArgs): Promise<void> {
  const fileName = `${root}/package.json`;

  const packageJson = JSON.parse(await readFile(fileName, 'utf8'));
  for (const depType of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (packageJson[depType]) {
      for (const packageName in packageJson[depType]) {
        if (packageName.startsWith('@temporalio/')) {
          packageJson[depType][packageName] = sdkVersion;
        }
      }
    }
  }
  await writeFile(fileName, JSON.stringify(packageJson, null, 2));
}
