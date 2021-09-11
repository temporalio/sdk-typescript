// Modified from: https://github.com/vercel/next.js/blob/2425f4703c4c6164cecfdb6aa8f80046213f0cc6/packages/create-next-app/helpers/install.ts
import { spawn } from './subprocess';

interface InstallArgs {
  root: string;

  /**
   * Indicate whether to install packages using Yarn.
   */
  useYarn: boolean;
}

/**
 * Spawn a package manager installation with either Yarn or NPM.
 *
 * @returns A Promise that resolves once the installation is finished.
 */
export function install({ root, useYarn }: InstallArgs): Promise<void> {
  const command: string = useYarn ? 'yarn' : 'npm';

  return spawn(command, ['install'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ADBLOCK: '1', DISABLE_OPENCOLLECTIVE: '1' },
  });
}

export async function installTsconfig({ root, useYarn }: InstallArgs): Promise<void> {
  const command: string = useYarn ? 'yarn' : 'npm';

  const currentNodeVersion = +process.versions.node.split('.')[0];
  const versionAlreadyInPackageJson = 16;
  const minimumValidVersion = 14;
  if (currentNodeVersion >= minimumValidVersion && currentNodeVersion !== versionAlreadyInPackageJson) {
    const packageName = `@tsconfig/node${currentNodeVersion}@latest`;

    // update .nvmrc
    await spawn(`echo`, [currentNodeVersion.toString(), '>', '.nvmrc'], { shell: true, cwd: root });

    return spawn(command, ['install', '--save', packageName], {
      cwd: root,
      stdio: ['inherit', 'inherit', 'ignore'], // ignore stderr
      env: { ...process.env, ADBLOCK: '1', DISABLE_OPENCOLLECTIVE: '1' },
    });
  }
}
