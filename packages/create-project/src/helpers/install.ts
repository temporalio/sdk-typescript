// Modified from: https://github.com/vercel/next.js/blob/2425f4703c4c6164cecfdb6aa8f80046213f0cc6/packages/create-next-app/helpers/install.ts
import { spawn } from './subprocess';

interface InstallArgs {
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
export function install({ useYarn }: InstallArgs): Promise<void> {
  const command: string = useYarn ? 'yarn' : 'npm';

  return spawn(command, ['install'], {
    stdio: 'inherit',
    env: { ...process.env, ADBLOCK: '1', DISABLE_OPENCOLLECTIVE: '1' },
  });
}
