// Modified from: https://github.com/vercel/next.js/blob/2425f4703c4c6164cecfdb6aa8f80046213f0cc6/packages/create-next-app/helpers/should-use-yarn.ts
import { execSync } from 'child_process';

const COMMAND_NOT_FOUND_SH_CODE = 127;

export function shouldUseYarn(): boolean {
  try {
    const userAgent = process.env.npm_config_user_agent;
    if (userAgent) {
      return Boolean(userAgent && userAgent.startsWith('yarn'));
    }

    execSync('yarnpkg --version', { stdio: 'ignore' });
    return true;
  } catch (e: any) {
    if (e.status === COMMAND_NOT_FOUND_SH_CODE || /not found/i.test(e.message)) {
      return false;
    }

    throw e;
  }
}
